/**
 * @file renderer.js
 * Desenho do enxame no canvas.
 *
 * Três regras governam este ficheiro, todas elas medidas e não supostas.
 *
 * 1. MINIMIZAR MUDANÇAS DE ESTADO DO CONTEXTO.
 *    Cada atribuição a globalAlpha fecha o lote em curso no compositor.
 *    Desenhar três mil partículas por ordem de índice, cada uma com a sua
 *    opacidade, são três mil lotes de um elemento: o pior caso possível.
 *    A opacidade é por isso quantizada em dezasseis degraus, e as partículas
 *    são ordenadas por (plano, degrau) com uma ordenação por contagem, que é
 *    O(n) e não aloca nada. Ficam 96 escritas por fotograma em vez de três
 *    mil. O erro de quantização é de 3% de opacidade, abaixo do limiar de
 *    perceção.
 *
 * 2. TRANSFORMAÇÃO IDENTIDADE, COORDENADAS EM PÍXEIS DO DISPOSITIVO.
 *    O atlas é rasterizado à densidade real do ecrã; se o contexto estivesse
 *    escalado por dpr, cada drawImage teria de reduzir a célula e o browser
 *    reamostrava com filtragem bilinear. Uma serifa de 9 px reamostrada
 *    desaparece. Mantendo a identidade e multiplicando as posições por dpr
 *    aqui, cada cópia é exatamente 1:1.
 *
 * 3. A ROTAÇÃO É A EXCEÇÃO, E PAGA-SE ONDE É PRECISA.
 *    Uma letra em voo inclina-se conforme a direção em que vai, e isso obriga
 *    a uma matriz por partícula — que é duas a três vezes mais caro do que a
 *    cópia direta. Por isso as duas vias coexistem: quem está direito (um
 *    rosto composto, um poema escrito, que é a maioria das partículas quando
 *    há muitas) usa a via rápida, e só quem voa paga a matriz. A troca entre
 *    as duas é contada, para não se repor a identidade mais vezes do que o
 *    necessário.
 *
 * 4. DESTINO ARREDONDADO A PÍXEL INTEIRO.
 *    Um destino fracionário força a mesma reamostragem do ponto anterior, e
 *    em texto quase parado produz "fervura" do anti-aliasing: as hastes finas
 *    do Garamond tremem sem que nada se mova. Arredonda-se o DESTINO do
 *    desenho, nunca a posição guardada — arredondar o estado travaria o
 *    movimento lento num padrão de degraus.
 */

/** Degraus de quantização da opacidade. */
const ALPHA_STEPS = 16;

/** Abaixo disto a partícula não é desenhada: poupa a chamada e não se vê. */
const ALPHA_CUTOFF = 0.012;

/** Margem de recorte fora do ecrã, em píxeis de CSS. */
const CULL_MARGIN = 72;

/** Abaixo deste ângulo, em radianos, a rotação não se vê e usa-se a via
 *  rápida. Meio grau num glifo de vinte píxeis é menos de um décimo de
 *  píxel de deslocamento no canto. */
const ANGLE_EPSILON = 0.009;

/** Marca de "não desenhar" nos baldes. */
const SKIP = 255;

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./atlas.js').GlyphAtlas} atlas
   * @param {{ opacity: number }[]} layers Um por plano do atlas.
   * @param {number} capacity Número máximo de partículas.
   */
  constructor(canvas, atlas, layers, capacity) {
    this.canvas = canvas;
    this.atlas = atlas;
    this.layers = layers;

    // alpha: true porque o fundo é pintado pelo CSS — o papel, a sua vinheta
    // e a variação circadiana vivem todos em variables.css. Com alpha: false
    // ganhava-se algum desempenho de preenchimento, mas o fundo teria de ser
    // pintado aqui a cada fotograma, e a decisão sobre que branco é o branco
    // passava do CSS para o JavaScript. Não compensa.
    //
    // As opções só valem na PRIMEIRA chamada a getContext deste canvas: uma
    // segunda chamada devolve o mesmo contexto e ignora as opções, sem aviso.
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Não foi possível obter o contexto 2D do palco.');
    this.ctx = ctx;

    this.width = 0;
    this.height = 0;
    this.dpr = 1;

    /**
     * Plano mínimo a desenhar. O governador de qualidade sobe-o quando a
     * cadência cai: saltar os planos de fundo retira as partículas pequenas e
     * pálidas primeiro, o que lê como a neblina a aclarar, e não como um erro.
     */
    this.minTier = 0;

    const bucketCount = layers.length * ALPHA_STEPS;
    this.bucketCount = bucketCount;

    this.counts = new Uint32Array(bucketCount);
    this.offsets = new Uint32Array(bucketCount + 1);
    this.bucketOf = new Uint8Array(capacity);
    this.order = new Uint32Array(capacity);

    /** Quantas partículas foram desenhadas no último fotograma. */
    this.drawn = 0;
  }

  /**
   * @param {number} width Largura em píxeis de CSS.
   * @param {number} height Altura em píxeis de CSS.
   * @param {number} dpr
   */
  resize(width, height, dpr) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;

    // O canvas tem duas dimensões distintas: a do buffer, em píxeis do
    // dispositivo, e a de apresentação, em píxeis de CSS, fixada pelo
    // layout.css. Confundi-las é a causa número um de canvas desfocados.
    // Math.round e não Math.floor: com floor perde-se uma linha de píxeis e
    // as duas medidas desalinham-se.
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);

    // Identidade explícita: o canvas acabou de ser redimensionado, o que já a
    // repõe, mas deixá-lo implícito seria contar com um efeito secundário.
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Desenha um fotograma.
   * @param {import('./system.js').ParticleBuffers} p
   */
  render(p) {
    const ctx = this.ctx;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    // clearRect e não `canvas.width = canvas.width`: o segundo realoca o
    // buffer inteiro, 1 a 3 ms, e passa por ser um truque barato.
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    this.drawn = 0;

    if (!this.atlas.ready) return;

    const { count, x, y, alpha, tier, glyph, angle } = p;
    const counts = this.counts;
    const offsets = this.offsets;
    const bucketOf = this.bucketOf;
    const order = this.order;
    const minTier = this.minTier;

    counts.fill(0);

    // --- Passagem 1: a que balde pertence cada partícula -------------------
    const minX = -CULL_MARGIN;
    const maxX = this.width + CULL_MARGIN;
    const minY = -CULL_MARGIN;
    const maxY = this.height + CULL_MARGIN;

    for (let i = 0; i < count; i += 1) {
      const a = alpha[i];
      const t = tier[i];

      if (a < ALPHA_CUTOFF || t < minTier
        || x[i] < minX || x[i] > maxX || y[i] < minY || y[i] > maxY) {
        bucketOf[i] = SKIP;
        continue;
      }

      let step = (a * ALPHA_STEPS) | 0;
      if (step >= ALPHA_STEPS) step = ALPHA_STEPS - 1;

      const bucket = t * ALPHA_STEPS + step;
      bucketOf[i] = bucket;
      counts[bucket] += 1;
    }

    // --- Somas de prefixo ---------------------------------------------------
    let running = 0;
    for (let b = 0; b < this.bucketCount; b += 1) {
      offsets[b] = running;
      running += counts[b];
    }
    offsets[this.bucketCount] = running;

    if (running === 0) return;
    this.drawn = running;

    // --- Passagem 2: colocar os índices por ordem de balde ------------------
    // counts é reaproveitado como cursor: já não é preciso, e poupa um array.
    counts.fill(0);
    for (let i = 0; i < count; i += 1) {
      const bucket = bucketOf[i];
      if (bucket === SKIP) continue;
      order[offsets[bucket] + counts[bucket]] = i;
      counts[bucket] += 1;
    }

    // --- Passagem 3: desenhar balde a balde --------------------------------
    const atlas = this.atlas;
    const pages = atlas.pages;
    const sx = atlas.sx;
    const sw = atlas.sw;
    const sh = atlas.sh;
    const halfW = atlas.halfW;
    const halfH = atlas.halfH;
    const glyphCount = atlas.glyphCount;
    const layers = this.layers;
    const dpr = this.dpr;

    // A transformação em vigor é seguida à mão, para que a identidade só seja
    // reposta quando uma partícula direita vem a seguir a uma inclinada.
    let identidade = true;

    for (let b = 0; b < this.bucketCount; b += 1) {
      const start = offsets[b];
      const end = offsets[b + 1];
      if (start === end) continue;

      const layerIndex = (b / ALPHA_STEPS) | 0;
      const step = b % ALPHA_STEPS;

      // O centro do degrau, não a borda: reparte o erro de quantização.
      const quantized = (step + 0.5) / ALPHA_STEPS;
      ctx.globalAlpha = layers[layerIndex].opacity * quantized;

      const page = pages[layerIndex];

      for (let k = start; k < end; k += 1) {
        const i = order[k];
        const cell = layerIndex * glyphCount + glyph[i];
        const a = angle[i];

        if (a > ANGLE_EPSILON || a < -ANGLE_EPSILON) {
          // Via inclinada: a matriz leva a rotação e a translação de uma vez,
          // e o desenho passa a ser relativo ao centro do glifo.
          const cos = Math.cos(a);
          const sin = Math.sin(a);
          ctx.setTransform(cos, sin, -sin, cos, x[i] * dpr, y[i] * dpr);
          ctx.drawImage(
            page, sx[cell], 0, sw[cell], sh[cell],
            -halfW[cell], -halfH[cell], sw[cell], sh[cell],
          );
          identidade = false;
          continue;
        }

        if (!identidade) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          identidade = true;
        }

        // Math.round e não `| 0`: a truncatura de `| 0` puxa os negativos
        // para zero, o que num campo que atravessa a origem introduz um viés
        // de meio píxel só do lado esquerdo do ecrã.
        const dx = Math.round(x[i] * dpr - halfW[cell]);
        const dy = Math.round(y[i] * dpr - halfH[cell]);

        ctx.drawImage(page, sx[cell], 0, sw[cell], sh[cell], dx, dy, sw[cell], sh[cell]);
      }
    }

    if (!identidade) ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
}
