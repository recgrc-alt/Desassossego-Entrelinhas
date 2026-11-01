/**
 * @file director.js
 * A encenação: quem decide o que o enxame faz em cada etapa.
 *
 * É o único módulo que conhece ao mesmo tempo o sistema de partículas, os
 * amostradores, a navegação e a antologia. Tudo o resto é deliberadamente
 * ignorante: a física não sabe que existem poetas, a navegação não sabe que
 * existem partículas, e o amostrador de imagem não sabe o que é uma etapa.
 *
 * Quatro etapas, e as passagens entre elas:
 *
 *   intro → home → poet ⇄ poem
 *                    ↑______|
 *
 * Nenhuma delas pinta nada em DOM. O director escreve uma palavra em
 * document.body.dataset.stage e o CSS trata do resto (ver styles/main.css).
 */

import { clamp } from '../core/math.js';
import { EVENTS } from '../core/emitter.js';
import { seedFrom } from '../core/random.js';
import { findPoem, glyphPoolFor, glyphPoolForLibrary } from '../data/library.js';
import { projectCloud, sampleImage } from '../targets/image-sampler.js';
import { composePoem, planPoemLayout } from '../targets/text-sampler.js';
import { splitIntoLetters } from '../ui/letters.js';
import { WordDance } from './words.js';

/** Nomes das etapas. */
const STAGES = {
  INTRO: 'intro',
  HOME: 'home',
  POET: 'poet',
  POEM: 'poem',
};

/**
 * Índice do plano de leitura no atlas: vem a seguir aos quatro planos de
 * profundidade declarados no CSS, e é o único cujo corpo de letra muda em
 * tempo de execução, de poema para poema.
 */
export const READING_TIER = 4;

/**
 * Plano das palavras que se formam no campo. Vem a seguir ao de leitura, e
 * tem corpo próprio — maior do que qualquer plano de profundidade — porque
 * uma palavra feita no corpo das letras à volta não se lê como palavra: lê-se
 * como as mesmas letras a mexer.
 */
export const WORD_TIER = 5;

/** Teto da espera pelo carregamento, em milissegundos. */
const READY_TIMEOUT = 6000;

/** Fração do lado menor do ecrã ocupada por um retrato. */
const PORTRAIT_SCALE = 0.84;

/** Deslocamento vertical do retrato, em fração da altura. Ligeiramente
 *  abaixo do centro geométrico, porque o painel do nome ocupa o canto
 *  superior esquerdo e o peso visual tem de descer para compensar. */
const PORTRAIT_OFFSET_Y = 0.03;

/**
 * Densidade do campo flutuante da página inicial, em partículas por píxel
 * quadrado de viewport.
 *
 * Não é o orçamento todo, de propósito: o orçamento é dimensionado para a
 * resolução que um rosto exige — cerca de nove píxeis entre letras — e essa
 * densidade num campo aberto não é um campo, é uma parede, com o título a
 * perder-se lá dentro. Aqui são cerca de novecentas letras num ecrã de
 * portátil: suficientes para o ar ter grão, poucas para se contarem.
 */
const FIELD_DENSITY = 0.0011;

/** Fração do orçamento usada num retrato. O resto fica a boiar em volta, e é
 *  essa neblina que impede o rosto de parecer um recorte colado no ecrã. */
const PORTRAIT_SHARE = 0.82;

/**
 * Passo com que se percorre o conjunto de letras de um poeta ao compor-lhe o
 * rosto.
 *
 * Um número primo grande, e por isso coprimo com qualquer tamanho de conjunto
 * que apareça: o índice percorre o conjunto todo antes de repetir. Com um
 * passo pequeno — ou com um divisor do comprimento — pontos vizinhos do rosto
 * sairiam com letras vizinhas do poema, e via-se o texto a aparecer em
 * fiadas dentro da cara.
 */
const POOL_STRIDE = 7919;

/**
 * Tempo por que se espalha a troca das letras do campo, em segundos.
 *
 * Um segundo é o tempo que a composição de um rosto leva a assentar, e é por
 * isso o tempo que há para trocar as letras sem que a troca seja o
 * acontecimento. Mais depressa vê-se o campo a cintilar; mais devagar, e
 * quem volte atrás depressa encontra o campo ainda a meio da mudança.
 */
const RELETTER_SPAN = 1.1;

/**
 * Chave do conjunto de letras de toda a antologia, no cache dos conjuntos.
 * Não pode colidir com nenhum identificador de poeta, e não colide: os
 * identificadores vêm de data-poet e são nomes.
 */
const LIBRARY_KEY = '*';

/** Opacidade das partículas que sobram em cada etapa. */
const IDLE_ALPHA = {
  portrait: 0.1,
  poem: 0.09,
};

/** Fração da densidade do campo que fica a boiar por trás de um poema. Um
 *  terço: o suficiente para a página não ficar vazia à volta do texto, pouco
 *  para competir com ele. */
const POEM_HAZE_SHARE = 0.34;

/**
 * Limiares do governador de qualidade. A cadência é medida pelo intervalo
 * entre fotogramas, e a decisão só é tomada depois de muitos fotogramas
 * seguidos do mesmo lado — um pico isolado não é uma tendência.
 */
const QUALITY = {
  /** Abaixo desta cadência considera-se que não se está a aguentar. */
  slowDelta: 1 / 42,
  /** Acima desta considera-se que há folga para voltar atrás. */
  fastDelta: 1 / 56,
  /** Fotogramas maus seguidos antes de simplificar. */
  framesToDrop: 90,
  /** Fotogramas bons seguidos antes de voltar a encher. */
  framesToRestore: 300,
  /** Planos de fundo que podem ser retirados, no máximo. */
  maxDropped: 2,
  /**
   * Um telemóvel em poupança de energia corre a 30 Hz certinhos: cadência
   * baixa, variação quase nula. Não é uma máquina a sufocar, e simplificar
   * não lhe serviria de nada. Exige-se por isso que a cadência baixa venha
   * acompanhada de instabilidade.
   */
  jitterRatio: 0.16,
};


/**
 * Traduz o tom de um ponto do retrato no plano de profundidade que o vai
 * desenhar.
 *
 * É esta função que faz um rosto ler-se como rosto.
 *
 * A densidade sozinha não chega. A um espaçamento de dez ou doze píxeis — que
 * é o que há com alguns milhares de partículas — um olho e uma face recebem
 * números de letras parecidos, e o olho humano não distingue a diferença. O
 * que ele distingue, e de imediato, é o PESO: uma letra de vinte e dois
 * píxeis quase opaca ao lado de uma de nove quase transparente.
 *
 * Então o tom do píxel escolhe o corpo da letra. O preto do chapéu fica em
 * letras grandes e cheias, a penumbra da face em letras médias, a luz da
 * testa em letras pequenas e pálidas. O retrato passa a ter meios-tons
 * verdadeiros em vez de só ter contorno.
 *
 * O ruído de meio plano existe para quebrar as bandas: sem ele, as fronteiras
 * entre tons desenham curvas de nível visíveis, como um mapa topográfico.
 *
 * O plano mais distante fica de fora da escala. Ele existe para a neblina de
 * fundo — nove píxeis a 17% de opacidade — e nessa opacidade um rosto não se
 * vê. Os tons de um retrato repartem-se pelos três planos restantes, que vão
 * de doze píxeis a 42% até vinte e dois a 95%.
 *
 * @param {number} tone Em [0, 1].
 * @param {number} index Índice do ponto, para o ruído ser estável.
 * @param {number} layerCount
 * @returns {number}
 */
function tierForTone(tone, index, layerCount) {
  const lowest = 1;
  const span = layerCount - lowest;

  // Sequência de baixa discrepância (incremento áureo) em vez de aleatório:
  // é determinista, não precisa de gerador, e distribui-se melhor.
  const dither = ((index * 0.6180339887) % 1) - 0.5;
  const scaled = lowest + Math.pow(tone, 0.8) * span + dither * 0.9;
  return clamp(Math.floor(scaled), lowest, layerCount - 1);
}

/**
 * Espera um tempo.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

export class Director {
  /**
   * @param {object} options
   * @param {import('../particles/system.js').ParticleSystem} options.system
   * @param {import('../particles/renderer.js').Renderer} options.renderer
   * @param {import('../particles/atlas.js').GlyphAtlas} options.atlas
   * @param {import('../core/env.js').Environment} options.env
   * @param {import('../ui/nav.js').Navigation} options.nav
   * @param {import('../core/emitter.js').Emitter} options.bus
   * @param {import('../data/library.js').Poet[]} options.poets
   * @param {Map<string, import('../data/library.js').Poet>} options.index
   * @param {{ greeting: HTMLElement, intro: HTMLElement, poemFrame: HTMLElement }} options.elements
   */
  constructor({ system, renderer, atlas, env, nav, bus, poets, index, elements }) {
    this.system = system;
    this.renderer = renderer;
    this.atlas = atlas;
    this.env = env;
    this.nav = nav;
    this.bus = bus;
    this.poets = poets;
    this.index = index;
    this.el = elements;

    this.words = new WordDance({
      system,
      atlas,
      tiers: [WORD_TIER],
      avoid: elements.centre,
    });

    this.stage = STAGES.INTRO;

    /**
     * Modo parado: a página foi composta sem animação, para quem pediu menos
     * movimento. Com ele ligado o ciclo de animação não corre — e como é o
     * ciclo que move as partículas e desenha, cada composição tem de saltar
     * para o destino e pintar o seu próprio fotograma. Ver settle().
     */
    this.still = false;

    /** @type {import('../data/library.js').Poet | null} */
    this.currentPoet = null;
    /** @type {import('../data/library.js').Poem | null} */
    this.currentPoem = null;

    /**
     * Ficha de transição. Cada mudança de etapa incrementa este número; uma
     * tarefa assíncrona que volte e encontre outro número sabe que alguém
     * mudou de ideias entretanto e desiste em silêncio. Sem isto, clicar
     * depressa em dois poetas faz o primeiro rosto aterrar por cima do
     * segundo.
     */
    this.token = 0;

    this.quality = { dropped: 0, badFrames: 0, goodFrames: 0 };

    /**
     * Conjuntos de letras já extraídos, por autor. Extrair é percorrer alguns
     * milhares de caracteres e traduzi-los em índices do atlas: barato, mas
     * acontece a cada escolha de poeta e a cada redimensionamento da janela,
     * e não há razão para o repetir.
     * @type {Map<string, Uint16Array>}
     */
    this.pools = new Map();

    /**
     * De quem são as letras que o campo está a usar neste momento.
     *
     * Guardado para não repetir trabalho — recompor a mesma etapa depois de
     * um redimensionamento não tem de trocar letra nenhuma — e porque é ele
     * que faz do campo uma memória: ao voltar atrás, as letras não se
     * repõem. Quem sai de um rosto deixa o campo feito das letras daquele
     * poeta, e é com elas que a página fica até alguém escolher outro.
     */
    this.letteredAs = '';

    this.bus.on(EVENTS.POET_SELECTED, ({ poetId }) => { this.enterPoet(poetId); });
    this.bus.on(EVENTS.POEM_SELECTED, ({ poetId, poemId }) => { this.enterPoem(poetId, poemId); });
    this.bus.on(EVENTS.BACK, () => { this.goBack(); });
  }

  /**
   * Escreve a etapa no documento. É a única coisa que este módulo muda em DOM.
   * @private
   * @param {string} stage
   */
  setStage(stage) {
    this.stage = stage;
    document.body.dataset.stage = stage;
    this.token += 1;
    return this.token;
  }

  /**
   * Medidas da moldura onde o poema é composto, lidas do elemento que o CSS
   * posiciona. Assim a composição do poema continua a ser uma decisão de
   * folha de estilo e não um número escondido no JavaScript.
   * @private
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  poemFrame() {
    const rect = this.el.poemFrame.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  /**
   * A encenação de entrada.
   *
   * A palavra é texto verdadeiro no DOM — só assim a serifa sai nítida, com o
   * kerning e o hinting do browser. Chega, descansa, sobe e desvanece; depois
   * a folha onde está escrita levanta como uma névoa e por baixo aparece a
   * página, que entretanto já se montou e já está a mexer.
   *
   * A espera não é um tempo fixo. É o maior de dois: o tempo que a palavra
   * precisa de estar parada para ser lida, e o tempo que o site precisa para
   * ficar pronto — a tipografia descarregada, o atlas rasterizado, os cinco
   * retratos analisados. Enquanto um deles não acabar, a folha não levanta.
   * É para isto que uma página de entrada serve.
   *
   * A espera tem teto. Uma rede lenta, um CDN em baixo ou uma fotografia que
   * não decodifica não podem transformar uma página de entrada numa página
   * final: ao fim do tempo limite a folha levanta na mesma, e o que faltar
   * carrega-se quando for preciso.
   *
   * @param {Promise<unknown>} [ready] Promessa que resolve quando tudo o que
   *   a página precisa está carregado.
   * @returns {Promise<void>}
   */
  async runIntro(ready = Promise.resolve()) {
    const { greeting, intro } = this.el;
    const timing = this.env.introTiming;

    this.setStage(STAGES.INTRO);

    // O campo nasce com as letras de toda a antologia. Acontece agora, por
    // baixo da folha de entrada e com tudo ainda a zero de opacidade, e por
    // isso é instantâneo: não há nada para esconder.
    this.letterField(null);

    // Partir em letras ANTES de animar: a classe de chegada procura os
    // pedaços, e se ainda não existirem não anima coisa nenhuma.
    splitIntoLetters(greeting);
    greeting.classList.add('is-in');

    // O mínimo de permanência e o carregamento correm ao mesmo tempo; o que
    // manda é o que acabar por último — com um teto, para que nada fique
    // pendurado numa promessa que não resolve.
    await Promise.all([
      wait(timing.hold),
      Promise.race([ready, wait(READY_TIMEOUT)]),
    ]);

    greeting.classList.remove('is-in');
    greeting.classList.add('is-leaving');

    // A home começa a compor-se por trás da folha, enquanto a palavra ainda
    // sobe. Quando a névoa levantar não há nada a arrancar — há uma coisa que
    // já estava a acontecer, que é a diferença entre revelar e começar.
    await wait(timing.fade * 0.55);
    this.enterHome();

    await wait(timing.fade * 0.45);
    intro.classList.add('is-revealing');

    await wait(timing.reveal);
    intro.classList.add('is-done');
  }

  /** Campo flutuante com o título do projeto. */
  enterHome() {
    this.setStage(STAGES.HOME);
    this.currentPoet = null;
    this.currentPoem = null;
    this.nav.clearPoet();

    this.system.alphaLambda = 1.4;
    this.system.setSpring('word');
    this.system.setVeil(null);
    // Antes de dispersar, cada partícula volta já ao seu plano natural. Sem
    // isto, as que desenharam a saudação ficariam com sete píxeis de corpo
    // até chegarem a algum destino — e se a pessoa escolher um poeta nos
    // primeiros segundos, nunca chegam.
    this.system.resetTiers();
    this.system.disperse({ alpha: 1, visible: this.fieldCount() });
    this.settle();
    if (!this.still) this.words.start();
  }

  /**
   * Compõe o rosto de um poeta.
   * @param {string} poetId
   * @returns {Promise<void>}
   */
  async enterPoet(poetId) {
    const poet = this.index.get(poetId);
    if (!poet) return;

    // Recompor depois de a janela mudar de tamanho volta a passar por aqui
    // com o MESMO poeta. Reconstruir a lista de poemas nesse caso destruiria
    // os botões e criaria outros: o foco do teclado cairia para o corpo da
    // página a meio de uma navegação, e o leitor de ecrã voltaria a anunciar
    // o que já tinha anunciado. O painel só se refaz quando o autor muda.
    const outroPoeta = !this.currentPoet || this.currentPoet.id !== poet.id;

    const token = this.setStage(STAGES.POET);
    this.currentPoet = poet;
    this.currentPoem = null;

    this.words.stop();

    // Depois de parar as palavras, para que nenhuma esteja requisitada: uma
    // partícula presa a uma palavra não troca de letra, e ficaria a única
    // coisa no ecrã com letras do autor anterior.
    this.letterField(poet);

    if (outroPoeta) {
      this.nav.showPoet(poet);
      this.nav.announce(`A compor o rosto de ${poet.name}.`);
    } else {
      this.nav.clearPoem();
    }

    this.system.alphaLambda = 2.4;
    this.system.setSpring('portrait');
    this.system.setVeil(null);

    const targets = await this.portraitTargets(poet);

    if (!targets) {
      this.nav.announce(
        `Não foi possível compor o rosto de ${poet.name}. Os poemas dele estão em texto, no fim da página.`,
      );
      return;
    }

    // Alguém escolheu outro poeta enquanto a imagem era analisada.
    if (token !== this.token) return;

    this.system.assign(targets, { idleAlpha: IDLE_ALPHA.portrait });
    this.settle();
  }

  /**
   * Escreve um poema na grelha central.
   * @param {string} poetId
   * @param {string} poemId
   * @returns {Promise<void>}
   */
  async enterPoem(poetId, poemId) {
    const encontrado = findPoem(this.index, poetId, poemId);
    if (!encontrado) return;
    const { poet, poem } = encontrado;

    this.setStage(STAGES.POEM);
    this.currentPoet = poet;
    this.currentPoem = poem;

    this.words.stop();
    this.letterField(poet);
    this.nav.showPoem(poem, poet);
    this.nav.announce(`A escrever ${poem.title}, de ${poet.name}. O texto completo está na antologia, no fim da página.`);

    this.system.alphaLambda = 3.4;
    this.system.setSpring('poem');

    this.composeCurrentPoem();
  }

  /**
   * Compõe o poema em curso. Separado de enterPoem porque também é preciso
   * ao redimensionar a janela, onde a etapa não muda mas o enquadramento sim.
   * @private
   */
  composeCurrentPoem() {
    const poem = this.currentPoem;
    if (!poem) return;

    const frame = this.poemFrame();
    const reading = this.env.reading;

    const plan = planPoemLayout({
      text: poem.text,
      fontFamily: this.env.fontFamily,
      frame,
      reading,
    });

    // Rasterizar outra vez só o plano de leitura, e só se o corpo mudou mesmo.
    // Um soneto compõe-se maior do que um poema de quarenta versos, por isso
    // o corpo muda de poema para poema; reconstruir o atlas todo de cada vez
    // seria desperdício, e reconstruí-lo por meio píxel de diferença seria
    // um soluço de fotograma por nada.
    this.atlas.buildTier(READING_TIER, plan.size);



    const targets = composePoem(poem.text, {
      atlas: this.atlas,
      tier: READING_TIER,
      frame,
      columns: plan.columns,
      lineHeight: reading.lineHeight,
      tracking: reading.tracking,
      gutter: reading.gutter,
      alpha: 1,
    });

    // A zona de ar sai da mancha REAL do texto, medida nos destinos, e não da
    // moldura: a moldura tem a largura toda da coluna de leitura, e descontar
    // essa largura inteira apagaria metade do campo. O que tem de ficar limpo
    // é o bloco, mais a folga de uma entrelinha para o texto respirar.
    const folga = plan.size * reading.lineHeight;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const alvo of targets) {
      if (alvo.x < minX) minX = alvo.x;
      if (alvo.x > maxX) maxX = alvo.x;
      if (alvo.y < minY) minY = alvo.y;
      if (alvo.y > maxY) maxY = alvo.y;
    }

    this.system.setVeil(targets.length > 0 ? {
      x: minX - folga,
      y: minY - folga,
      width: (maxX - minX) + folga * 2,
      height: (maxY - minY) + folga * 2,
    } : null);

    this.system.assign(targets, {
      idleAlpha: IDLE_ALPHA.poem,
      idleVisible: Math.round(this.fieldCount() * POEM_HAZE_SHARE),
    });
    this.settle();
  }

  /**
   * Liga ou desliga o modo parado.
   * @param {boolean} on
   */
  setStill(on) {
    this.still = on;
    this.system.interactive = !on;
    if (on) this.settle();
  }

  /**
   * Fecha uma composição quando não há ciclo de animação para a executar.
   *
   * Em movimento isto não faz nada: as partículas viajam e o ciclo desenha.
   * Parado, salta-se para o fim e pinta-se uma vez — que é a única maneira de
   * escolher um poema, ou outro poeta, ter algum efeito visível.
   * @private
   */
  settle() {
    if (!this.still) return;
    this.system.snap();
    this.renderer.render(this.system.buffers);
  }

  /**
   * Analisa os cinco retratos com antecedência, e guarda-os em cache.
   *
   * Cada um custa entre 25 e 35 ms de trabalho — luminância, desfoque, níveis
   * automáticos, Sobel, amostragem. Feito no primeiro clique, seria um salto
   * no instante exato em que alguém está a olhar; feito durante a entrada,
   * acontece por trás de uma palavra parada no ecrã, e escolher um poeta
   * passa a ser instantâneo.
   *
   * Uma fotografia que falhe não impede a entrada: a promessa resolve na
   * mesma, e o erro reaparece — tratado — quando aquele poeta for escolhido.
   *
   * O número de pontos TEM de ser o mesmo que enterPoet vai pedir, senão a
   * chave da cache não coincide e todo este trabalho é deitado fora. Daí
   * viver aqui, ao lado da constante, e não em quem chama.
   *
   * @returns {Promise<unknown>}
   */
  warmPortraits() {
    const count = Math.floor(this.system.count * PORTRAIT_SHARE);

    return Promise.all(this.poets.map((poet) => sampleImage(poet.image, {
      count,
      seed: seedFrom(poet.id),
    }).catch((error) => {
      console.warn(`[arranque] O retrato de ${poet.name} não ficou pronto.`, error);
    })));
  }

  /**
   * Destinos que compõem o rosto de um poeta.
   *
   * Vive à parte porque é pedido por dois caminhos — a escolha normal de um
   * poeta e a composição do estado parado — e correr a mesma sequência de
   * amostragem, projeção e escolha de letras em dois sítios era garantir que
   * um dia divergiam.
   *
   * @private
   * @param {import('../data/library.js').Poet} poet
   * @returns {Promise<import('../particles/system.js').TargetPoint[] | null>}
   *   Null se a fotografia não puder ser lida.
   */
  async portraitTargets(poet) {
    let cloud;
    try {
      cloud = await sampleImage(poet.image, {
        count: Math.floor(this.system.count * PORTRAIT_SHARE),
        seed: seedFrom(poet.id),
      });
    } catch (error) {
      console.error(`[director] Não foi possível compor o rosto de ${poet.name}.`, error);
      return null;
    }

    const points = projectCloud(cloud, {
      width: this.system.width,
      height: this.system.height,
      scale: PORTRAIT_SCALE,
      offsetY: PORTRAIT_OFFSET_Y,
    });

    const pool = this.poolFor(poet);
    const depth = this.env.layers.length;

    return points.map((point, i) => ({
      x: point.x,
      y: point.y,
      glyph: pool.length > 0 ? pool[(i * POOL_STRIDE) % pool.length] : undefined,
      tier: tierForTone(point.tone, i, depth),
      alpha: 1,
    }));
  }

  /**
   * O conjunto de letras de um autor, ou de toda a antologia.
   *
   * @private
   * @param {import('../data/library.js').Poet | null} poet Nulo para a
   *   antologia inteira.
   * @returns {Uint16Array}
   */
  poolFor(poet) {
    const key = poet ? poet.id : LIBRARY_KEY;
    let pool = this.pools.get(key);

    if (!pool) {
      pool = poet
        ? glyphPoolFor(poet, this.atlas)
        : glyphPoolForLibrary(this.poets, this.atlas);
      this.pools.set(key, pool);
    }

    return pool;
  }

  /**
   * Veste o campo com as letras de alguém.
   *
   * O campo não é um alfabeto: é texto desfeito. Enquanto ninguém escolheu,
   * são as letras dos cinco poetas somadas; a partir de uma escolha, são as
   * daquele — e as mesmas letras que vão compor o rosto dele são as que
   * continuam a flutuar por trás. Um sorteio uniforme sobre o alfabeto do
   * atlas punha no ar uma maiúscula em cada três letras e um algarismo em
   * cada doze, proporções que não existem em nenhuma língua; tirá-las dos
   * versos põe no ar o que uma página de poesia tem.
   *
   * @private
   * @param {import('../data/library.js').Poet | null} poet
   */
  letterField(poet) {
    const key = poet ? poet.id : LIBRARY_KEY;
    if (key === this.letteredAs) return;
    this.letteredAs = key;

    // Em modo parado não há ciclo de animação para escalonar a troca, e uma
    // fila que nunca anda deixaria o campo a meio caminho entre dois autores.
    this.system.reglyph(this.poolFor(poet), { over: this.still ? 0 : RELETTER_SPAN });
  }

  /**
   * Quantas partículas ficam acesas no campo da página inicial.
   *
   * A densidade é por área, e divide-se pelo QUADRADO da escala dos corpos.
   *
   * O rosto e o campo têm problemas opostos, e é preciso não confundi-los. No
   * rosto, o número de pontos está preso ao teto do orçamento enquanto a cara
   * cresce com o ecrã: as letras afastam-se e engrossá-las é o que repõe o
   * desenho. No campo não há teto nenhum — o número já acompanha a área, e a
   * densidade já estava certa. Engrossar as letras aqui não corrige coisa
   * nenhuma: acrescenta tinta a quem já tinha a dose certa, e um ecrã grande
   * passava a abrir com uma parede de letras por trás do título. Visto e
   * corrigido, não deduzido.
   *
   * O peso visual de um campo é o número de letras vezes a área de cada uma.
   * Se o corpo cresce `s` vezes, a área cresce `s²`, e manter o peso obriga a
   * dividir o número por `s²`. O resultado é o que se quer num ecrã maior:
   * o mesmo desenho, com o grão à escala — menos letras, maiores.
   *
   * @private
   * @returns {number}
   */
  fieldCount() {
    const area = this.system.width * this.system.height;
    const escala = this.env.glyphScale || 1;
    return Math.min(this.system.count, Math.round((area * FIELD_DENSITY) / (escala * escala)));
  }

  /** Recua um passo: do poema para o rosto, do rosto para o campo. */
  goBack() {
    if (this.stage === STAGES.POEM && this.currentPoet) {
      this.nav.clearPoem();
      this.enterPoet(this.currentPoet.id);
      return;
    }
    if (this.stage === STAGES.POET) {
      this.enterHome();
      this.nav.focusFirst('poets');
    }
  }

  /**
   * Recompõe a etapa atual depois de a janela mudar de tamanho.
   * A etapa não muda; o que muda é o enquadramento.
   */
  recompose() {
    if (this.stage === STAGES.POEM) {
      this.composeCurrentPoem();
      return;
    }
    if (this.stage === STAGES.POET && this.currentPoet) {
      this.enterPoet(this.currentPoet.id);
      return;
    }
    if (this.stage === STAGES.HOME) {
      this.system.disperse({ alpha: 1, visible: this.fieldCount() });
      this.settle();
    }
  }

  /**
   * Um fotograma.
   * @param {number} dt Segundos.
   * @param {number} time Segundos desde o arranque.
   * @param {import('../core/loop.js').Loop} loop
   */
  update(dt, time, loop) {
    this.system.update(dt, time);

    if (this.stage === STAGES.HOME) {
      this.words.update(dt, { width: this.system.width, height: this.system.height });
    }

    this.renderer.render(this.system.buffers);
    this.governQuality(loop);
  }

  /**
   * Governador de qualidade.
   *
   * Quando a máquina não aguenta, retira-se o plano de fundo mais distante:
   * são as partículas mais pequenas e mais pálidas, e vê-se a neblina a
   * aclarar, não um erro. Reduzir o número total de partículas cortando o
   * fim do array faria o contrário — tiraria só as da frente, as grandes, e
   * o rosto mudava de carácter em vez de simplificar.
   *
   * @private
   * @param {import('../core/loop.js').Loop} loop
   */
  governQuality(loop) {
    const delta = loop.smoothedDelta;
    const unstable = loop.jitter > delta * QUALITY.jitterRatio;
    const q = this.quality;

    if (delta > QUALITY.slowDelta && unstable) {
      q.goodFrames = 0;
      q.badFrames += 1;

      if (q.badFrames >= QUALITY.framesToDrop && q.dropped < QUALITY.maxDropped) {
        q.dropped += 1;
        q.badFrames = 0;
        this.renderer.minTier = q.dropped;
      }
      return;
    }

    if (delta < QUALITY.fastDelta) {
      q.badFrames = 0;
      q.goodFrames += 1;

      if (q.goodFrames >= QUALITY.framesToRestore && q.dropped > 0) {
        q.dropped -= 1;
        q.goodFrames = 0;
        this.renderer.minTier = q.dropped;
      }
      return;
    }

    q.badFrames = 0;
    q.goodFrames = 0;
  }

  /**
   * Compõe de uma vez o estado final, sem animação nenhuma.
   *
   * É o que se mostra a quem pediu menos movimento: o rosto do primeiro poeta
   * já formado, parado, e a antologia em texto por baixo. Um site que é feito
   * de movimento não pode responder a essa preferência com um ecrã vazio.
   *
   * @returns {Promise<void>}
   */
  async composeStill() {
    const { greeting, intro } = this.el;
    greeting.classList.add('is-handed-over');
    intro.classList.add('is-done');

    const poet = this.poets.find((candidate) => candidate.poems.length > 0) || this.poets[0];
    if (!poet) return;

    this.setStage(STAGES.POET);
    this.currentPoet = poet;
    this.nav.showPoet(poet);

    this.setStill(true);
    this.system.setSpring('portrait');
    this.letterField(poet);

    const targets = await this.portraitTargets(poet);
    if (!targets) return;

    this.system.assign(targets, { idleAlpha: IDLE_ALPHA.portrait, teleport: true });
    this.settle();
  }
}
