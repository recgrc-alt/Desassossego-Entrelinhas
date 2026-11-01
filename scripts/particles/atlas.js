/**
 * @file atlas.js
 * Atlas de glifos pré-rasterizados.
 *
 * PORQUÊ UM ATLAS
 * Desenhar milhares de letras por fotograma com fillText é inviável. Cada
 * chamada obriga o motor de texto a procurar o glifo, aplicar hinting,
 * rasterizar e compor: três a dez microssegundos. Três mil chamadas são 9 a
 * 30 ms — o fotograma inteiro, e mais.
 *
 * A alternativa é rasterizar cada carácter uma única vez, em cada corpo de
 * letra usado, para um canvas fora do ecrã, e depois copiar retângulos com
 * drawImage: 0.3 a 1.5 microssegundos cada. As mesmas três mil letras passam
 * a custar cerca de 2 ms. Não é uma otimização — é a decisão que torna o
 * projeto possível, e tem de estar na arquitetura desde a primeira linha,
 * porque condiciona o formato do estado, o agrupamento da opacidade e o
 * arredondamento das posições.
 *
 * UM CANVAS POR PLANO, NÃO UM ÚNICO
 * O plano de leitura muda de corpo de letra sempre que se escolhe um poema —
 * um soneto de catorze versos compõe-se maior do que um poema de quarenta.
 * Com um atlas único, cada mudança obrigaria a rasterizar outra vez os seis
 * planos; com um canvas por plano, reconstrói-se só aquele.
 *
 * EM PÍXEIS DO DISPOSITIVO
 * O atlas é rasterizado à densidade real do ecrã e o contexto principal fica
 * com a transformação identidade (ver renderer.js). Assim cada drawImage é
 * uma cópia exata, sem reamostragem. Aplicar ctx.scale(dpr, dpr) obrigaria o
 * browser a reamostrar com filtragem bilinear, e uma serifa de 9 px
 * reamostrada é uma mancha cinzenta — exatamente o que um site tipográfico
 * não pode permitir.
 */

/**
 * Alfabeto disponível para as partículas.
 *
 * Cobre a acentuação portuguesa completa e a pontuação da poesia, incluindo o
 * apóstrofo das elisões ("minh'alma", "p'ra") e os travessões de Sá-Carneiro.
 * Qualquer carácter de um poema que não esteja nesta lista é saltado na
 * composição, por isso a lista é generosa.
 */
export const ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'áàâãéèêíìóòôõúùüçÁÀÂÃÉÈÊÍÌÓÒÔÕÚÙÜÇ',
  ...'0123456789',
  ...'.,;:!?…—–-«»“”‘’\'"()[]/&',
].join('');

/**
 * Margem à volta de cada célula, em fração do corpo de letra.
 *
 * Um quarto do corpo, e não um valor fixo em píxeis: os itálicos do EB
 * Garamond transbordam a largura de avanço, e o transbordo cresce com o
 * tamanho. Sem margem suficiente, as serifas ficam cortadas e aparecem
 * fantasmas do glifo vizinho por sangria da filtragem.
 */
const PADDING_RATIO = 0.25;

/** Margem mínima absoluta, em píxeis de CSS. */
const PADDING_MIN = 2;

/**
 * Atlas de glifos para um conjunto de corpos de letra, um plano por corpo.
 */
export class GlyphAtlas {
  /**
   * @param {object} options
   * @param {number[]} options.sizes Corpos de letra, em píxeis de CSS, um por plano.
   * @param {string} options.fontFamily Pilha de fontes, tal como vem do CSS
   *   (com as aspas: no Safari, um nome de família com espaços sem aspas numa
   *   string de ctx.font é inválido e o contexto mantém a fonte anterior, em
   *   silêncio).
   * @param {string} options.color Cor da tinta. A opacidade NÃO é cozida aqui:
   *   é aplicada no desenho, para que o mesmo atlas sirva todos os estados de
   *   desvanecimento.
   * @param {number} options.dpr
   * @param {string} [options.alphabet]
   */
  constructor({ sizes, fontFamily, color, dpr, alphabet = ALPHABET }) {
    this.sizes = sizes.slice();
    this.fontFamily = fontFamily;
    this.color = color;
    this.dpr = dpr;
    this.alphabet = alphabet;

    /** Posição de cada carácter no alfabeto, para traduzir texto em índices. */
    this.indexOf = new Map();
    for (let i = 0; i < alphabet.length; i += 1) {
      this.indexOf.set(alphabet[i], i);
    }

    this.tierCount = sizes.length;
    this.glyphCount = alphabet.length;

    const cells = this.tierCount * this.glyphCount;

    /** Retângulo de origem no atlas do plano, em píxeis do dispositivo. */
    this.sx = new Float32Array(cells);
    this.sw = new Float32Array(cells);
    this.sh = new Float32Array(cells);

    /** Metade da célula, em píxeis do dispositivo. Pré-calculada porque o
     *  desenho a usa duas vezes por partícula para centrar o glifo. */
    this.halfW = new Float32Array(cells);
    this.halfH = new Float32Array(cells);

    /** Largura de avanço de cada glifo, em píxeis de CSS. Usada pelo
     *  compositor de texto para medir versos. */
    this.advance = new Float32Array(cells);

    /** Avanço do espaço, por plano. O espaço não tem tinta, logo não tem
     *  partícula — mas ocupa lugar num verso e tem de ser medido. */
    this.spaceAdvance = new Float32Array(this.tierCount);

    /** Um canvas por plano. @type {HTMLCanvasElement[]} */
    this.pages = sizes.map(() => document.createElement('canvas'));

    this.ready = false;
  }

  /**
   * Índice interno de uma célula.
   * @param {number} tier
   * @param {number} glyph
   * @returns {number}
   */
  cell(tier, glyph) {
    return tier * this.glyphCount + glyph;
  }

  /**
   * Traduz um carácter no seu índice de glifo.
   * @param {string} char
   * @returns {number} -1 se o carácter não existe no alfabeto.
   */
  glyphFor(char) {
    const index = this.indexOf.get(char);
    return index === undefined ? -1 : index;
  }

  /** Rasteriza todos os planos. */
  build() {
    for (let tier = 0; tier < this.tierCount; tier += 1) {
      this.buildTier(tier);
    }
    this.ready = true;
    return this;
  }

  /**
   * Rasteriza um plano, opcionalmente com um corpo de letra novo.
   *
   * @param {number} tier
   * @param {number} [size] Corpo em píxeis de CSS. Omitido, mantém o atual.
   * @returns {boolean} Falso se nada foi feito por o corpo já ser o pedido.
   */
  buildTier(tier, size) {
    if (size !== undefined) {
      // Meio píxel de diferença não se vê e não paga uma rasterização.
      if (this.ready && Math.abs(this.sizes[tier] - size) < 0.5) return false;
      this.sizes[tier] = size;
    }

    const body = this.sizes[tier];
    const dpr = this.dpr;
    const padding = Math.max(PADDING_MIN, body * PADDING_RATIO);
    const canvas = this.pages[tier];

    // Primeira passagem: medir. Mede-se num contexto à parte porque
    // redimensionar o canvas de destino limpa-o, e não se pode medir e
    // desenhar no mesmo sem o fazer duas vezes.
    const measurer = document.createElement('canvas').getContext('2d');
    if (!measurer) throw new Error('Contexto 2D indisponível para medir os glifos.');
    measurer.font = `${body}px ${this.fontFamily}`;

    this.spaceAdvance[tier] = measurer.measureText(' ').width;

    // Altura igual para todos os glifos do plano: assim a célula tem sempre o
    // mesmo centro vertical e o desenho não precisa de corrigir a linha de
    // base carácter a carácter. Como se usa textBaseline 'middle', que é uma
    // métrica da fonte e não da tinta, um 'p' e um 'o' ficam alinhados entre
    // si tal como ficariam numa linha de texto.
    const cellHeightCss = Math.ceil(body * 1.5 + padding * 2);
    const cellHeight = Math.ceil(cellHeightCss * dpr);

    const widths = new Array(this.glyphCount);
    let totalWidth = 0;

    for (let g = 0; g < this.glyphCount; g += 1) {
      const metrics = measurer.measureText(this.alphabet[g]);

      // actualBoundingBox* dá a caixa real da tinta, que em serifas itálicas
      // transborda a largura de avanço. Onde não exista ou venha a zero
      // (Safari antigo), uma estimativa sobre o avanço cobre o caso.
      const inkLeft = Number.isFinite(metrics.actualBoundingBoxLeft)
        ? metrics.actualBoundingBoxLeft
        : metrics.width * 0.2;
      const inkRight = Number.isFinite(metrics.actualBoundingBoxRight) && metrics.actualBoundingBoxRight > 0
        ? metrics.actualBoundingBoxRight
        : metrics.width * 1.1;

      const inkWidth = Math.max(metrics.width, inkLeft + inkRight, 1);
      const cellWidth = Math.ceil((inkWidth + padding * 2) * dpr);

      widths[g] = cellWidth;
      totalWidth += cellWidth;
      this.advance[this.cell(tier, g)] = metrics.width;
    }

    canvas.width = totalWidth;
    canvas.height = cellHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Contexto 2D indisponível para desenhar os glifos.');

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${body}px ${this.fontFamily}`;

    let x = 0;
    for (let g = 0; g < this.glyphCount; g += 1) {
      const cellWidth = widths[g];
      const index = this.cell(tier, g);

      ctx.fillText(this.alphabet[g], (x + cellWidth / 2) / dpr, cellHeightCss / 2);

      this.sx[index] = x;
      this.sw[index] = cellWidth;
      this.sh[index] = cellHeight;
      this.halfW[index] = cellWidth / 2;
      this.halfH[index] = cellHeight / 2;

      x += cellWidth;
    }

    return true;
  }

  /**
   * Bytes ocupados por todos os planos. Serve o orçamento de memória de canvas
   * do iOS, onde exceder o teto faz o Safari descartar canvas em silêncio —
   * ficam brancos, sem erro nenhum na consola.
   * @returns {number}
   */
  byteSize() {
    let bytes = 0;
    for (const page of this.pages) bytes += page.width * page.height * 4;
    return bytes;
  }

  /**
   * Liberta a memória. Encolher para 1×1 devolve o buffer de imediato; largar
   * a referência e esperar pelo recolhedor de lixo não chega, sobretudo no
   * Safari.
   */
  dispose() {
    for (const page of this.pages) {
      page.width = 1;
      page.height = 1;
    }
    this.ready = false;
  }
}
