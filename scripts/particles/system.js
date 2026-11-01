/**
 * @file system.js
 * O enxame. Guarda o estado de todas as partículas e sabe reorganizá-las.
 *
 * ESTRUTURA DE DADOS
 * Os dados estão em "struct of arrays": um array tipado por propriedade, em
 * vez de um array de objetos. Três mil objetos `{x, y, vx, vy, ...}` ficam
 * espalhados pela heap, cada leitura é uma falha de cache, e a pressão sobre
 * o recolhedor de lixo manifesta-se em picos de 20 a 40 ms de poucos em
 * poucos segundos — o tipo de soluço que não aparece numa média de fotogramas
 * por segundo e que estraga uma peça contemplativa. Três mil posições x
 * seguidas num Float32Array cabem em poucas linhas de cache, e depois do
 * arranque não se aloca mais nada.
 *
 * O preço é legibilidade: não há uma "partícula" para inspecionar no
 * depurador, só índices. Daí nada aqui estar abreviado.
 */

import { clamp, hilbertIndex } from '../core/math.js';
import { createRandom, randomRange } from '../core/random.js';
import { FLOW, POINTER, SPRINGS, STIFFNESS_CLASSES, stepParticles } from './physics.js';

/** Marca de "sem troca pendente" no array de glifos pendentes. */
const NO_PENDING = 0xffff;

/** Distância base, em píxeis de CSS, a que uma partícula se considera chegada. */
const ARRIVE_DISTANCE = 7;

/**
 * Opacidade abaixo da qual se considera que ninguém vê uma partícula.
 *
 * Serve a troca de caracteres: uma letra a 4% de opacidade, num corpo de nove
 * a vinte e dois píxeis, pode mudar de identidade no mesmo fotograma sem que
 * se note. Acima disto a troca tem de ser escalonada. Ver reglyph.
 */
const RELETTER_UNSEEN = 0.04;

/** Ordem da curva de Hilbert: grelha de 1024×1024, mais fina do que qualquer
 *  ecrã precisa. */
const HILBERT_ORDER = 10;
const HILBERT_SIDE = 1 << HILBERT_ORDER;

/** Vizinhos examinados em cada passagem de 2-opt, e número de passagens. */
const TWO_OPT_NEIGHBOURS = 6;
const TWO_OPT_PASSES = 3;

/**
 * Distribuição das partículas pelos quatro planos de profundidade.
 * Mais massa atrás do que à frente: é o que dá a leitura de neblina
 * tipográfica em vez de confetti.
 */
const LAYER_WEIGHTS = [0.38, 0.3, 0.22, 0.1];

/**
 * @typedef {object} ParticleBuffers
 * @property {number} count
 * @property {Float32Array} x
 * @property {Float32Array} y
 * @property {Float32Array} vx
 * @property {Float32Array} vy
 * @property {Float32Array} tx Destino.
 * @property {Float32Array} ty
 * @property {Float32Array} delay Segundos que faltam até ser libertada.
 * @property {Float32Array} phase Fase própria da deriva.
 * @property {Float32Array} freq Frequência própria da deriva, em rad/s.
 * @property {Float32Array} amp Amplitude da respiração, em px.
 * @property {Float32Array} speed Velocidade de cruzeiro no campo de
 *   correntes, em px/s. Própria de cada partícula, e maior nos planos da
 *   frente: é o que faz o campo ter profundidade em vez de deslizar todo
 *   junto.
 * @property {Float32Array} angle Inclinação atual, em radianos.
 * @property {Float32Array} homeX Zona a que a partícula livre está amarrada.
 * @property {Float32Array} homeY
 * @property {Uint8Array} held 1 se a partícula tem destino e é puxada por uma
 *   mola; 0 se é livre e navega o campo de correntes. É a distinção que
 *   separa as letras que compõem alguma coisa das que estão a voar.
 * @property {Float32Array} parallax Resposta ao cursor, em [0, ~1.4].
 * @property {Float32Array} alpha Opacidade atual.
 * @property {Float32Array} alphaTarget Opacidade pretendida.
 * @property {Uint8Array} tier Plano de profundidade atual.
 * @property {Uint8Array} homeTier Plano natural. O `tier` muda quando a
 *   partícula é requisitada para ler um poema ou formar uma palavra; este não
 *   muda nunca, e é para aqui que ela volta.
 * @property {Uint8Array} stiffness Classe de rigidez, índice em STIFFNESS_CLASSES.
 * @property {Uint16Array} glyph Índice do carácter no alfabeto do atlas.
 * @property {Uint16Array} pendingGlyph Carácter a adotar à chegada.
 * @property {Uint8Array} pendingTier Plano a adotar à chegada.
 */

/**
 * @typedef {object} TargetPoint
 * @property {number} x
 * @property {number} y
 * @property {number} [glyph] Índice de glifo a adotar à chegada.
 * @property {number} [tier] Plano a adotar à chegada. Por omissão, o natural.
 * @property {number} [alpha] Opacidade pretendida.
 * @property {number} [delay] Atraso antes de partir, em segundos.
 */

export class ParticleSystem {
  /**
   * @param {object} options
   * @param {import('./atlas.js').GlyphAtlas} options.atlas
   * @param {{ parallax: number }[]} options.layers Um por plano do atlas.
   * @param {number} options.count
   * @param {number} options.width
   * @param {number} options.height
   * @param {number} [options.seed]
   */
  constructor({ atlas, layers, count, width, height, seed = 20260411 }) {
    this.atlas = atlas;
    this.layers = layers;
    this.width = width;
    this.height = height;
    this.random = createRandom(seed);

    const n = count;

    /** @type {ParticleBuffers} */
    this.buffers = {
      count: n,
      x: new Float32Array(n),
      y: new Float32Array(n),
      vx: new Float32Array(n),
      vy: new Float32Array(n),
      tx: new Float32Array(n),
      ty: new Float32Array(n),
      delay: new Float32Array(n),
      phase: new Float32Array(n),
      freq: new Float32Array(n),
      amp: new Float32Array(n),
      speed: new Float32Array(n),
      angle: new Float32Array(n),
      homeX: new Float32Array(n),
      homeY: new Float32Array(n),
      held: new Uint8Array(n),
      parallax: new Float32Array(n),
      alpha: new Float32Array(n),
      alphaTarget: new Float32Array(n),
      tier: new Uint8Array(n),
      homeTier: new Uint8Array(n),
      stiffness: new Uint8Array(n),
      glyph: new Uint16Array(n),
      pendingGlyph: new Uint16Array(n),
      pendingTier: new Uint8Array(n),
    };

    /** Rascunhos do emparelhamento, reservados uma vez para que uma transição
     *  não aloque memória nenhuma. */
    this.orderScratch = new Uint32Array(n);
    this.keyScratch = new Float64Array(n);
    this.targetOrder = new Uint32Array(n);
    this.targetKeys = new Float64Array(n);
    this.usedScratch = new Uint8Array(n);
    this.pairParticle = new Uint32Array(n);
    this.pairTarget = new Uint32Array(n);

    /** Fila da troca escalonada de caracteres. Reservada aqui, como as
     *  outras, para que trocar as letras do campo não aloque memória. */
    this.reletterQueue = new Uint32Array(n);

    /** Opacidade que cada partícula tinha antes de ser requisitada para uma
     *  palavra. Sem isto, devolvê-la ao campo acendia-a — e como o campo
     *  deixa a maioria apagada de propósito, cada palavra que se formava e
     *  desfazia deixava o ecrã um pouco mais cheio do que antes. */
    this.restAlpha = new Float32Array(n);

    this.pendingCount = 0;

    /** Estado do cursor, já suavizado, com a velocidade medida. */
    this.pointer = {
      x: width / 2,
      y: height / 2,
      rawX: width / 2,
      rawY: height / 2,
      speed: 0,
      active: false,
    };
    this.pointerRadius = this.computePointerRadius();

    /** @type {keyof typeof SPRINGS} */
    this.springName = 'word';

    /** Rapidez do desvanecimento, em unidades de opacidade por segundo. */
    this.alphaLambda = 3.2;

    /** Posto a falso com movimento reduzido: sem campo de cursor, sem voo. */
    this.interactive = true;

    /**
     * Mancha de um poema em construção. Nula quando não há poema aberto.
     * @type {import('./physics.js').VeilRect | null}
     */
    this.veil = null;

    /**
     * Troca de caracteres em curso, ou nula. Ver reglyph.
     * @type {{ pool: Uint16Array | number[], cursor: number, length: number,
     *   perSecond: number, due: number } | null}
     */
    this.relettering = null;

    this.seedParticles();
  }

  /** @returns {number} */
  get count() {
    return this.buffers.count;
  }

  /**
   * Raio do campo do cursor: fração da diagonal, limitada em píxeis.
   * @private
   * @returns {number}
   */
  computePointerRadius() {
    const diagonal = Math.sqrt(this.width * this.width + this.height * this.height);
    return clamp(POINTER.radiusRatio * diagonal, POINTER.radiusMin, POINTER.radiusMax);
  }

  /**
   * Dá a cada partícula a sua identidade fixa: plano, classe de rigidez,
   * carácter inicial, fase e amplitude de deriva. Corre uma só vez.
   * @private
   */
  seedParticles() {
    const p = this.buffers;
    const rng = this.random;
    const glyphCount = this.atlas.glyphCount;
    const classCount = STIFFNESS_CLASSES.length;

    // Fronteiras acumuladas dos pesos, para escolher o plano com uma só
    // comparação em vez de um ciclo sobre todos.
    const bounds = [];
    let acc = 0;
    for (const weight of LAYER_WEIGHTS) {
      acc += weight;
      bounds.push(acc);
    }

    for (let i = 0; i < p.count; i += 1) {
      const roll = rng();
      let tier = 0;
      while (tier < bounds.length - 1 && roll > bounds[tier]) tier += 1;

      p.tier[i] = tier;
      p.homeTier[i] = tier;
      p.parallax[i] = this.layers[tier].parallax;

      // A classe de rigidez acompanha o plano — os planos de fundo são mais
      // lentos, como convém a quem está mais longe — com dispersão suficiente
      // para que duas partículas vizinhas nunca cheguem exatamente juntas.
      const base = (tier / (LAYER_WEIGHTS.length - 1)) * (classCount - 1);
      const jittered = base + (rng() - 0.5) * 2.2;
      p.stiffness[i] = clamp(Math.round(jittered), 0, classCount - 1);

      p.glyph[i] = Math.floor(rng() * glyphCount) % glyphCount;
      p.pendingGlyph[i] = NO_PENDING;
      p.pendingTier[i] = tier;

      p.phase[i] = rng() * Math.PI * 2;
      // Frequências baixas e todas diferentes: períodos de 15 a 70 segundos.
      p.freq[i] = randomRange(rng, 0.09, 0.42);
      // Os planos de trás respiram mais: estão "mais longe", logo mais soltos.
      p.amp[i] = randomRange(rng, 14, 44) * (1.3 - tier * 0.18);

      // A velocidade de cruzeiro cresce com o plano. Um plano de fundo que
      // viajasse à mesma velocidade do da frente destruiria a profundidade
      // que o tamanho e a opacidade constroem — o olho usa a velocidade
      // relativa como a pista mais forte de distância que tem.
      const camada = tier / (LAYER_WEIGHTS.length - 1);
      p.speed[i] = randomRange(rng, FLOW.speedMin, FLOW.speedMax) * (0.55 + camada * 0.75);
      p.angle[i] = 0;
      p.held[i] = 0;

      p.alpha[i] = 0;
      p.alphaTarget[i] = 0;
    }

    this.scatterPositions();
  }

  /**
   * Espalha as partículas pelo ecrã.
   *
   * Corre uma vez, ao nascer. Não há âncoras nem posições de repouso: uma
   * partícula livre navega o campo de correntes e dá a volta pelas bordas,
   * por isso a distribuição inicial dilui-se sozinha ao fim de alguns
   * segundos. O que isto evita é apenas que o primeiro fotograma seja um jato
   * a sair do canto superior esquerdo.
   *
   * Semente própria e fixa, independente da do construtor: o arranque é o
   * mesmo em todas as visitas.
   * @private
   */
  scatterPositions() {
    const rng = createRandom(0x9e3779b9);
    const p = this.buffers;
    const margem = FLOW.margin;

    for (let i = 0; i < p.count; i += 1) {
      p.homeX[i] = -margem + rng() * (this.width + margem * 2);
      p.homeY[i] = -margem + rng() * (this.height + margem * 2);
      p.x[i] = p.homeX[i];
      p.y[i] = p.homeY[i];
      p.tx[i] = p.x[i];
      p.ty[i] = p.y[i];
    }
  }

  /**
   * Ajusta o sistema a um novo tamanho de janela.
   *
   * As posições são escaladas, não reinicializadas: redimensionar uma janela
   * não deve desfazer o rosto que está no ecrã.
   *
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    const sx = this.width > 0 ? width / this.width : 1;
    const sy = this.height > 0 ? height / this.height : 1;
    const p = this.buffers;

    for (let i = 0; i < p.count; i += 1) {
      p.x[i] *= sx;
      p.y[i] *= sy;
      p.tx[i] *= sx;
      p.ty[i] *= sy;
      p.homeX[i] *= sx;
      p.homeY[i] *= sy;
    }

    this.width = width;
    this.height = height;
    this.pointerRadius = this.computePointerRadius();
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {boolean} active
   */
  setPointer(x, y, active) {
    this.pointer.rawX = x;
    this.pointer.rawY = y;
    this.pointer.active = active && this.interactive;
  }

  /**
   * Escolhe o perfil de mola em vigor.
   * @param {keyof typeof SPRINGS} name
   */
  setSpring(name) {
    if (SPRINGS[name]) this.springName = name;
  }

  /**
   * Define a mancha de um poema: a área onde as letras que não lhe pertencem
   * deixam de ser desenhadas.
   *
   * Não há força nenhuma envolvida — as letras continuam a atravessar a
   * página como sempre, simplesmente não aparecem por cima do texto. O
   * porquê de não ser uma expulsão está em physics.js, na constante VEIL.
   *
   * @param {{ x: number, y: number, width: number, height: number } | null} rect
   */
  setVeil(rect) {
    this.veil = rect
      ? {
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2,
        halfWidth: rect.width / 2,
        halfHeight: rect.height / 2,
      }
      : null;
  }

  /**
   * Marca uma troca de carácter e/ou de plano para ser aplicada à chegada.
   *
   * Existe como método único porque a mesma decisão — "isto muda alguma coisa?
   * então põe na fila; não muda? então limpa a fila" — aparece em todos os
   * caminhos que atribuem destinos, e a contabilidade de `pendingCount` tem de
   * estar certa nos dois sentidos: se ficar alta demais, o resolvedor corre
   * para sempre sem resolver nada; se ficar baixa, deixa de correr e as
   * letras nunca mudam.
   *
   * @private
   * @param {number} i
   * @param {number | undefined} glyph
   * @param {number} tier
   */
  queueSwap(i, glyph, tier) {
    const p = this.buffers;
    const wanted = glyph === undefined ? p.glyph[i] : glyph;
    const hadPending = p.pendingGlyph[i] !== NO_PENDING;
    const needed = wanted !== p.glyph[i] || tier !== p.tier[i];

    if (needed) {
      if (!hadPending) this.pendingCount += 1;
      p.pendingGlyph[i] = wanted;
      p.pendingTier[i] = tier;
    } else {
      if (hadPending) this.pendingCount -= 1;
      p.pendingGlyph[i] = NO_PENDING;
      p.pendingTier[i] = tier;
    }
  }

  /**
   * Aplica já a troca, sem esperar pela chegada.
   * @private
   * @param {number} i
   * @param {number | undefined} glyph
   * @param {number} tier
   */
  applySwap(i, glyph, tier) {
    const p = this.buffers;
    if (p.pendingGlyph[i] !== NO_PENDING) {
      this.pendingCount -= 1;
      p.pendingGlyph[i] = NO_PENDING;
    }
    if (glyph !== undefined) p.glyph[i] = glyph;
    p.tier[i] = tier;
    p.pendingTier[i] = tier;
    p.parallax[i] = this.layers[tier].parallax;
  }

  /**
   * Entrega um novo conjunto de destinos ao enxame.
   *
   * O PROBLEMA: há N partículas no ecrã e M destinos. Qual vai para qual?
   * Numerar os dois conjuntos pela ordem em que aparecem e emparelhá-los
   * produz um caos de trajetórias cruzadas — o ecrã fica com ar de máquina de
   * lavar e a forma só se lê no fim. A atribuição ótima pelo método húngaro
   * resolve-o em O(n³): com 3000 pontos, minutos.
   *
   * A SOLUÇÃO, em três partes:
   *
   * 1. Normalizar cada conjunto pela sua própria caixa delimitadora, EIXO A
   *    EIXO. É este detalhe que permite a um rosto quadrado desdobrar-se num
   *    bloco de texto largo e baixo sem cruzamentos: o mapa passa a ser uma
   *    transformação afim seguida da curva, em vez de uma correspondência
   *    entre coordenadas absolutas que já não são comparáveis.
   *
   * 2. Ordenar ambos pela mesma curva de Hilbert e emparelhar por posição na
   *    lista. A curva preserva a vizinhança, por isso partículas próximas
   *    recebem destinos próximos.
   *
   * 3. Limpar com 2-opt local. A curva tem saltos longos nas fronteiras de
   *    quadrante e deixa um ou dois por cento de viajantes atravessados, que
   *    são exatamente aqueles em que o olho se fixa. Para o funcional Σd², a
   *    troca entre dois pares reduz o custo exatamente quando
   *    (pa − pb) · (tb − ta) > 0 — um produto interno, sem raízes nem quatro
   *    distâncias. E o mínimo de Σd² é, por definição, um mapa monótono: sem
   *    cruzamentos.
   *
   * Custo total medido em ordem de grandeza: cerca de 1 ms para 3000 pontos,
   * contra um orçamento de 16.
   *
   * @param {TargetPoint[]} targets
   * @param {object} [options]
   * @param {number} [options.idleAlpha] Opacidade das partículas que sobram.
   * @param {boolean} [options.teleport] Se verdadeiro, as partículas nascem já
   *   no destino em vez de viajarem até lá. Usado na saudação de entrada, onde
   *   a nuvem tem de aparecer exatamente por cima da palavra que está no DOM.
   * @param {number} [options.idleVisible] Quantas das que sobram ficam
   *   acesas. Omitido, todas. Serve para que um poema não tenha de competir
   *   com milhares de letras de fundo: o orçamento é dimensionado para a
   *   resolução de um rosto, e essa densidade atrás de um texto torna-o
   *   ilegível.
   * @param {number} [options.thenFadeTo] Só com teleport: a partícula aparece
   *   com a opacidade do destino e passa a tender para esta. É o que faz a
   *   saudação aparecer em grão e logo começar a desvanecer — e, como a
   *   opacidade está presa ao atraso de cada partícula, a desvanecer na
   *   ordem em que foram escalonadas.
   */
  assign(targets, {
    idleAlpha = 0.18,
    idleVisible,
    teleport = false,
    thenFadeTo,
  } = {}) {
    const p = this.buffers;
    const n = p.count;
    const m = Math.min(targets.length, n);

    if (m === 0) {
      this.disperse({ alpha: idleAlpha });
      return;
    }

    // --- Caixas delimitadoras dos dois conjuntos ---------------------------
    let pminX = Infinity; let pminY = Infinity; let pmaxX = -Infinity; let pmaxY = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (p.x[i] < pminX) pminX = p.x[i];
      if (p.x[i] > pmaxX) pmaxX = p.x[i];
      if (p.y[i] < pminY) pminY = p.y[i];
      if (p.y[i] > pmaxY) pmaxY = p.y[i];
    }

    let tminX = Infinity; let tminY = Infinity; let tmaxX = -Infinity; let tmaxY = -Infinity;
    for (let j = 0; j < m; j += 1) {
      const t = targets[j];
      if (t.x < tminX) tminX = t.x;
      if (t.x > tmaxX) tmaxX = t.x;
      if (t.y < tminY) tminY = t.y;
      if (t.y > tmaxY) tmaxY = t.y;
    }

    const pScaleX = pmaxX > pminX ? HILBERT_SIDE / (pmaxX - pminX) : 0;
    const pScaleY = pmaxY > pminY ? HILBERT_SIDE / (pmaxY - pminY) : 0;
    const tScaleX = tmaxX > tminX ? HILBERT_SIDE / (tmaxX - tminX) : 0;
    const tScaleY = tmaxY > tminY ? HILBERT_SIDE / (tmaxY - tminY) : 0;

    // --- Ordenar as partículas pela curva ---------------------------------
    // Os arrays tipados aceitam comparador em .sort(), por isso a ordenação
    // acontece no sítio e não há alocação nenhuma.
    const keys = this.keyScratch;
    const particleOrder = this.orderScratch;
    for (let i = 0; i < n; i += 1) {
      particleOrder[i] = i;
      const gx = clamp(Math.floor((p.x[i] - pminX) * pScaleX), 0, HILBERT_SIDE - 1);
      const gy = clamp(Math.floor((p.y[i] - pminY) * pScaleY), 0, HILBERT_SIDE - 1);
      keys[i] = hilbertIndex(HILBERT_ORDER, gx, gy);
    }
    particleOrder.sort((a, b) => keys[a] - keys[b]);

    // --- Ordenar os destinos pela mesma curva -----------------------------
    const targetKeys = this.targetKeys;
    const targetOrder = this.targetOrder.subarray(0, m);
    for (let j = 0; j < m; j += 1) {
      targetOrder[j] = j;
      const t = targets[j];
      const gx = clamp(Math.floor((t.x - tminX) * tScaleX), 0, HILBERT_SIDE - 1);
      const gy = clamp(Math.floor((t.y - tminY) * tScaleY), 0, HILBERT_SIDE - 1);
      targetKeys[j] = hilbertIndex(HILBERT_ORDER, gx, gy);
    }
    targetOrder.sort((a, b) => targetKeys[a] - targetKeys[b]);

    // --- Emparelhar por posição na lista ----------------------------------
    // As partículas que sobram (n − m) são salteadas ao longo da ordem, não
    // cortadas do fim: assim as que ficam sem destino não são todas as de um
    // canto do ecrã, e a forma recebe material de toda a parte.
    const pairParticle = this.pairParticle;
    const pairTarget = this.pairTarget;
    const stride = n / m;

    for (let j = 0; j < m; j += 1) {
      pairParticle[j] = particleOrder[Math.min(n - 1, Math.floor(j * stride))];
      pairTarget[j] = targetOrder[j];
    }

    this.refinePairs(targets, m);

    // --- Escrever a atribuição --------------------------------------------
    const used = this.usedScratch;
    used.fill(0);

    for (let j = 0; j < m; j += 1) {
      const i = pairParticle[j];
      const target = targets[pairTarget[j]];
      const tier = target.tier ?? p.homeTier[i];

      p.tx[i] = target.x;
      p.ty[i] = target.y;
      p.delay[i] = target.delay ?? 0;
      p.alphaTarget[i] = target.alpha ?? 1;
      p.held[i] = 1;
      used[i] = 1;

      if (teleport) {
        p.x[i] = target.x;
        p.y[i] = target.y;
        p.vx[i] = 0;
        p.vy[i] = 0;
        this.applySwap(i, target.glyph, tier);
        // Aparece já com a opacidade do destino — é uma troca, não uma
        // chegada. Se houver um segundo valor para onde tender, é ele que
        // governa a partir daqui.
        p.alpha[i] = target.alpha ?? 1;
        if (thenFadeTo !== undefined) p.alphaTarget[i] = thenFadeTo;
      } else {
        this.queueSwap(i, target.glyph, tier);
      }
    }

    // --- O que sobra -------------------------------------------------------
    const idleLimit = idleVisible === undefined ? Infinity : idleVisible;
    let idleSeen = 0;

    for (let i = 0; i < n; i += 1) {
      if (used[i]) continue;

      // As que sobram deixam de ter destino: voam. Antes eram presas a uma
      // âncora fixa e tremiam à volta dela, o que lia como ruído parado em
      // vez de neblina. Livres, continuam a atravessar o ecrã por trás do
      // rosto ou do poema, que é o que lhes compete.
      p.held[i] = 0;
      p.delay[i] = 0;
      p.alphaTarget[i] = idleSeen < idleLimit ? idleAlpha : 0;
      idleSeen += 1;
      this.queueSwap(i, undefined, p.homeTier[i]);
    }
  }

  /**
   * Passagens de 2-opt sobre os pares já formados.
   *
   * Só se examinam vizinhos próximos na ordem da curva: como vizinhos em
   * ordem de Hilbert são vizinhos no plano, é entre eles que estão quase
   * todos os pares que podem estar cruzados.
   *
   * O `break` depois de cada troca não é cosmético: sem ele, `ta` e `tb`
   * ficam obsoletos no resto do ciclo interior e criam-se atribuições
   * duplicadas, que aparecem no ecrã como letras empilhadas no mesmo sítio.
   *
   * @private
   * @param {TargetPoint[]} targets
   * @param {number} m
   */
  refinePairs(targets, m) {
    const p = this.buffers;
    const pairParticle = this.pairParticle;
    const pairTarget = this.pairTarget;

    for (let pass = 0; pass < TWO_OPT_PASSES; pass += 1) {
      let swaps = 0;

      for (let a = 0; a < m; a += 1) {
        const ia = pairParticle[a];
        const pax = p.x[ia];
        const pay = p.y[ia];
        const ta = targets[pairTarget[a]];

        const limit = Math.min(m, a + 1 + TWO_OPT_NEIGHBOURS);
        for (let b = a + 1; b < limit; b += 1) {
          const ib = pairParticle[b];
          const tb = targets[pairTarget[b]];

          // Trocar reduz Σd² exatamente quando (pa − pb) · (tb − ta) > 0.
          const gain = (pax - p.x[ib]) * (tb.x - ta.x) + (pay - p.y[ib]) * (tb.y - ta.y);
          if (gain > 0) {
            const swap = pairTarget[a];
            pairTarget[a] = pairTarget[b];
            pairTarget[b] = swap;
            swaps += 1;
            break;
          }
        }
      }

      if (swaps === 0) break;
    }
  }

  /**
   * Atribui destinos apenas às partículas mais próximas, deixando as restantes
   * exatamente onde estavam.
   *
   * É o que permite que uma palavra se forme no meio do campo flutuante sem
   * interromper o campo: só as letras que já andavam ali perto são chamadas.
   * Chamar partículas do outro lado do ecrã daria a leitura errada — a palavra
   * pareceria aterrar, em vez de emergir.
   *
   * Dentro do grupo escolhido o emparelhamento é por abcissa, e não pela curva
   * de Hilbert: uma palavra é uma linha horizontal, e ordenar por x faz com
   * que as letras venham da esquerda para a direita sem se cruzarem.
   *
   * @param {TargetPoint[]} targets
   * @param {object} [options]
   * @param {number} [options.alpha]
   * @returns {Uint32Array} Índices das partículas requisitadas.
   */
  assignNearest(targets, { alpha = 1 } = {}) {
    const p = this.buffers;
    const n = p.count;
    const m = Math.min(targets.length, n);
    if (m === 0) return new Uint32Array(0);

    let cx = 0;
    let cy = 0;
    for (let j = 0; j < m; j += 1) {
      cx += targets[j].x;
      cy += targets[j].y;
    }
    cx /= m;
    cy /= m;

    // Só partículas LIVRES podem ser chamadas. Sem esta condição, duas
    // palavras formadas ao mesmo tempo disputavam as mesmas letras: a segunda
    // roubava à primeira, que ficava com buracos, e a contabilidade da
    // opacidade de repouso trocava-se — havia palavras no ar cujas letras já
    // tinham sido devolvidas ao campo, e letras devolvidas ao campo com a
    // opacidade errada. Pôr a distância a infinito tira-as da ordenação sem
    // precisar de um segundo array.
    const order = this.orderScratch;
    const keys = this.keyScratch;
    for (let i = 0; i < n; i += 1) {
      order[i] = i;
      if (p.held[i] === 1) {
        keys[i] = Infinity;
        continue;
      }
      const dx = p.x[i] - cx;
      const dy = p.y[i] - cy;
      keys[i] = dx * dx + dy * dy;
    }
    order.sort((a, b) => keys[a] - keys[b]);

    const chosen = order.slice(0, m);
    chosen.sort((a, b) => p.x[a] - p.x[b]);
    const byX = targets.slice().sort((a, b) => a.x - b.x);

    for (let j = 0; j < m; j += 1) {
      const i = chosen[j];
      const target = byX[j];

      this.restAlpha[i] = p.alphaTarget[i];
      p.tx[i] = target.x;
      p.ty[i] = target.y;
      p.delay[i] = target.delay ?? 0;
      p.alphaTarget[i] = target.alpha ?? alpha;
      p.held[i] = 1;
      this.queueSwap(i, target.glyph, target.tier ?? p.homeTier[i]);
    }

    return chosen;
  }

  /**
   * Devolve um grupo de partículas ao campo disperso e ao seu plano natural.
   *
   * A opacidade volta ao que ERA antes de a partícula ser requisitada, e não
   * a um valor fixo. O campo da página inicial deixa a maioria das partículas
   * apagada de propósito — só acende as que cabem na densidade escolhida — e
   * uma palavra chama as que estão mais perto, acesas ou não. Devolvê-las
   * todas acesas fazia o campo encher-se de forma monótona: ao fim de alguns
   * minutos, cada palavra que se tinha formado e desfeito tinha deixado lá
   * umas dezenas de letras a mais.
   *
   * @param {Uint32Array} indices
   * @param {object} [options]
   * @param {number} [options.alpha] Força uma opacidade, em vez da de repouso.
   * @param {number} [options.burst] Velocidade com que se afastam do centro
   *   do grupo, em px/s. É o que faz uma palavra ABRIR-SE em vez de ficar ali
   *   amontoada à espera que a corrente a desmanche.
   */
  release(indices, { alpha, burst = 0 } = {}) {
    const p = this.buffers;

    let cx = 0;
    let cy = 0;
    if (burst > 0 && indices.length > 0) {
      for (let k = 0; k < indices.length; k += 1) {
        cx += p.x[indices[k]];
        cy += p.y[indices[k]];
      }
      cx /= indices.length;
      cy /= indices.length;
    }

    for (let k = 0; k < indices.length; k += 1) {
      const i = indices[k];
      p.held[i] = 0;
      p.delay[i] = 0;
      p.alphaTarget[i] = alpha ?? this.restAlpha[i];

      if (burst > 0) {
        const dx = p.x[i] - cx;
        const dy = p.y[i] - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        // A uma letra exatamente no centro falta direção; fica para a
        // corrente, que a leva na mesma.
        if (d > 0.5) {
          p.vx[i] += (dx / d) * burst;
          p.vy[i] += (dy / d) * burst;
        }
      }

      this.queueSwap(i, undefined, p.homeTier[i]);
    }
  }

  /**
   * Devolve já toda a gente ao seu plano natural, sem esperar por chegada.
   *
   * As trocas de plano são normalmente aplicadas à chegada, porque é isso que
   * faz um poema parecer escrito. Há um caso em que isso não serve: o fim da
   * saudação de entrada. As partículas que a desenharam ficam no plano da
   * intro, que é de sete píxeis — e enquanto não chegarem a lado nenhum,
   * continuam a ser desenhadas a sete píxeis. Se a pessoa escolher um poeta
   * antes de o campo assentar, centenas de letras atravessam o ecrã quase
   * invisíveis e o rosto demora a aparecer.
   *
   * Aqui a troca é instantânea, e não se vê, porque acontece no momento em
   * que a nuvem da saudação já se desvaneceu.
   */
  resetTiers() {
    const p = this.buffers;
    for (let i = 0; i < p.count; i += 1) {
      this.applySwap(i, undefined, p.homeTier[i]);
    }
  }

  /**
   * Põe toda a gente no destino, já, sem viagem nenhuma.
   *
   * Existe para o modo parado — o que é oferecido a quem pediu menos
   * movimento. Nesse modo o ciclo de animação não corre, e sem ciclo nada se
   * move: um destino atribuído ficaria atribuído para sempre e o ecrã não
   * mudava. Aqui o estado salta para onde devia ter chegado, as trocas de
   * carácter e de plano são aplicadas, e basta desenhar um fotograma.
   */
  snap() {
    const p = this.buffers;
    this.finishRelettering();
    for (let i = 0; i < p.count; i += 1) {
      // Só as presas têm destino para onde saltar. Uma partícula livre não
      // tem lugar nenhum marcado — fica onde está, que é o que o campo de
      // correntes a teria deixado fazer.
      if (p.held[i] === 1) {
        p.x[i] = p.tx[i];
        p.y[i] = p.ty[i];
      }
      p.vx[i] = 0;
      p.vy[i] = 0;
      p.angle[i] = 0;
      p.delay[i] = 0;
      p.alpha[i] = p.alphaTarget[i];

      const pending = p.pendingGlyph[i];
      this.applySwap(i, pending === NO_PENDING ? undefined : pending, p.pendingTier[i]);
    }
  }

  /**
   * Manda toda a gente de volta ao campo disperso.
   *
   * O orçamento de partículas é dimensionado para o que um RETRATO precisa —
   * cerca de nove píxeis de espaçamento, que é o limiar a partir do qual uma
   * cara se reconhece. Um campo flutuante com essa densidade não é um campo,
   * é ruído: o título deixa de se ler e o ecrã fica uma parede de letras.
   * Daí `visible`, que deixa acesas só as primeiras. Como o plano de cada
   * partícula foi sorteado no nascimento, as primeiras são uma amostra
   * representativa de todos os planos — não é preciso escolher.
   *
   * @param {object} [options]
   * @param {number} [options.alpha]
   * @param {number} [options.visible] Quantas ficam acesas. Omitido, todas.
   */
  disperse({ alpha = 1, visible } = {}) {
    const p = this.buffers;
    const limit = visible === undefined ? p.count : Math.min(p.count, Math.max(0, visible));

    for (let i = 0; i < p.count; i += 1) {
      p.held[i] = 0;
      p.delay[i] = 0;
      p.alphaTarget[i] = i < limit ? alpha : 0;
      this.queueSwap(i, undefined, p.homeTier[i]);
    }
  }

  /**
   * Troca os caracteres das partículas por outros, tirados de um conjunto. É
   * assim que o campo passa a ser feito das letras de um autor em vez de um
   * alfabeto qualquer.
   *
   * Três grupos, e três tratamentos. A regra é uma só: uma letra pode mudar
   * de identidade quando ninguém a está a ver mudar.
   *
   *   PRESAS        — não se tocam. Uma partícula presa está a desenhar
   *                   alguma coisa: um ponto de um rosto, uma letra de um
   *                   verso, uma letra de uma palavra. O carácter dela foi
   *                   escolhido por quem lhe deu o destino, e trocá-lo aqui
   *                   apagaria letras de um poema a meio de o escrever. Estas
   *                   recebem a letra certa em assign, ponto por ponto.
   *
   *   LIVRES E      — trocam já. É o caso do arranque, em que o campo ainda
   *   INVISÍVEIS      está todo a zero por baixo da folha de entrada, e o da
   *                   reserva de partículas que o campo deixa apagada de
   *                   propósito (ver disperse).
   *
   *   LIVRES E      — ficam em fila e trocam umas poucas por fotograma.
   *   À VISTA         Uma partícula livre não tem destino, logo não existe a
   *                   "chegada" onde as outras trocas se escondem (ver
   *                   resolveArrivals): a troca só pode acontecer no
   *                   fotograma em que for pedida, e mil letras a mudar de
   *                   carácter ao mesmo tempo lêem-se como uma falha de
   *                   desenho. Espalhadas por um segundo são cerca de uma por
   *                   cento por fotograma, e o campo muda de identidade sem
   *                   que se veja o instante em que mudou.
   *
   * @param {Uint16Array | number[]} pool Índices de glifo válidos no atlas,
   *   COM repetições: o sorteio respeita a frequência real das letras.
   * @param {object} [options]
   * @param {number} [options.over] Segundos por que se espalha a troca das
   *   que estão à vista. A zero, é tudo já — serve o modo parado, onde não há
   *   ciclo de animação para escalonar coisa nenhuma.
   */
  reglyph(pool, { over = 0 } = {}) {
    if (pool.length === 0) return;

    const p = this.buffers;
    const queue = this.reletterQueue;
    let queued = 0;

    for (let i = 0; i < p.count; i += 1) {
      if (p.held[i] === 1) continue;

      if (over > 0 && p.alpha[i] > RELETTER_UNSEEN) {
        queue[queued] = i;
        queued += 1;
        continue;
      }

      this.reletterOne(i, pool);
    }

    this.relettering = queued > 0
      ? { pool, cursor: 0, length: queued, perSecond: queued / over, due: 0 }
      : null;
  }

  /**
   * Dá a uma partícula livre uma letra tirada do conjunto.
   *
   * Volta a testar `held` porque entre o pedido e a vez dela na fila pode ter
   * sido requisitada para um rosto ou para um verso — e nesse caso já tem a
   * letra que lhe foi destinada, que não é esta.
   *
   * O plano preservado é o PENDENTE, quando há um: uma partícula acabada de
   * largar de um poema ainda tem o plano de leitura em vigor e o seu plano
   * natural à espera na fila. Aplicar aqui o plano em vigor apagaria essa
   * espera, e a letra ficava com corpo de leitura para sempre.
   *
   * @private
   * @param {number} index
   * @param {Uint16Array | number[]} pool
   */
  reletterOne(index, pool) {
    const p = this.buffers;
    if (p.held[index] === 1) return;

    const picked = pool[Math.floor(this.random() * pool.length) % pool.length];
    const tier = p.pendingGlyph[index] === NO_PENDING ? p.tier[index] : p.pendingTier[index];
    this.applySwap(index, picked, tier);
  }

  /**
   * Avança a troca escalonada de caracteres.
   * @private
   * @param {number} dt Segundos.
   */
  stepRelettering(dt) {
    const job = this.relettering;

    // O resto fracionário fica guardado de um fotograma para o outro. Sem
    // ele, uma cadência alta arredondaria sempre para baixo — a 120 Hz, sete
    // partículas e meia por fotograma truncam a sete — e a troca acabaria
    // mais tarde do que o pedido, ou não acabaria.
    job.due += job.perSecond * dt;
    const quota = Math.floor(job.due);
    if (quota <= 0) return;
    job.due -= quota;

    const end = Math.min(job.length, job.cursor + quota);
    for (let k = job.cursor; k < end; k += 1) {
      this.reletterOne(this.reletterQueue[k], job.pool);
    }
    job.cursor = end;

    if (job.cursor >= job.length) this.relettering = null;
  }

  /**
   * Termina de imediato a troca que estava a decorrer.
   *
   * Existe para o modo parado: sem ciclo de animação a fila nunca andaria, e
   * o campo ficava com metade das letras de um autor e metade das do
   * anterior. snap() é, por definição, o salto para o estado final.
   * @private
   */
  finishRelettering() {
    const job = this.relettering;
    if (!job) return;

    for (let k = job.cursor; k < job.length; k += 1) {
      this.reletterOne(this.reletterQueue[k], job.pool);
    }
    this.relettering = null;
  }

  /**
   * Um passo completo.
   * @param {number} dt Segundos.
   * @param {number} time Segundos desde o arranque.
   */
  update(dt, time) {
    const spring = SPRINGS[this.springName];
    const pointer = this.pointer;

    // O cursor é suavizado antes de entrar na física: lido em bruto salta
    // dezenas de píxeis entre eventos e o campo de forças estremece. A
    // velocidade é medida sobre o valor já suavizado, pela mesma razão.
    const follow = 1 - Math.exp(-18 * dt);
    const prevX = pointer.x;
    const prevY = pointer.y;
    pointer.x += (pointer.rawX - pointer.x) * follow;
    pointer.y += (pointer.rawY - pointer.y) * follow;

    const movedX = pointer.x - prevX;
    const movedY = pointer.y - prevY;
    const instant = dt > 0 ? Math.sqrt(movedX * movedX + movedY * movedY) / dt : 0;
    pointer.speed += (instant - pointer.speed) * (1 - Math.exp(-10 * dt));

    if (this.relettering) this.stepRelettering(dt);

    stepParticles(
      this.buffers,
      {
        omega: spring.omega,
        zeta: spring.zeta,
        drift: this.interactive ? spring.drift : 0,
        pointerActive: pointer.active,
        pointerX: pointer.x,
        pointerY: pointer.y,
        pointerRadius: this.pointerRadius,
        pointerSpeed: pointer.speed,
        alphaLambda: this.alphaLambda,
        width: this.width,
        height: this.height,
        tilt: this.interactive,
        veil: this.veil,
      },
      dt,
      time,
    );

    if (this.pendingCount > 0) this.resolveArrivals(this.interactive ? spring.drift : 0);
  }

  /**
   * Troca o carácter e o plano das partículas que já chegaram.
   *
   * A troca à chegada, e não à partida, é o que produz a leitura de um poema a
   * ser escrito: a letra viaja como era e só se torna a letra certa quando
   * pousa no verso.
   *
   * O limiar de chegada acompanha a deriva em vigor. Uma partícula num campo
   * disperso oscila dezenas de píxeis em torno do destino e nunca estaria a
   * sete píxeis dele — a fila de trocas ficava presa para sempre e este ciclo
   * passava a correr em todos os fotogramas sem nunca resolver nada. Num
   * poema, onde a deriva é quase nula, o limiar volta a ser apertado e a letra
   * só troca quando está mesmo no sítio.
   *
   * @private
   * @param {number} driftScale
   */
  resolveArrivals(driftScale) {
    const p = this.buffers;
    let remaining = 0;

    for (let i = 0; i < p.count; i += 1) {
      if (p.pendingGlyph[i] === NO_PENDING) continue;

      // Uma partícula livre não tem destino, logo não pode chegar a lado
      // nenhum. A troca é aplicada já: ninguém repara numa letra a mudar de
      // carácter no meio de um campo em movimento, e deixá-la na fila para
      // sempre punha este ciclo a correr em todos os fotogramas sem resolver
      // nada.
      if (p.held[i] === 0) {
        p.glyph[i] = p.pendingGlyph[i];
        const freeTier = p.pendingTier[i];
        p.tier[i] = freeTier;
        p.parallax[i] = this.layers[freeTier].parallax;
        p.pendingGlyph[i] = NO_PENDING;
        continue;
      }

      const reach = ARRIVE_DISTANCE + p.amp[i] * driftScale;
      const dx = p.tx[i] - p.x[i];
      const dy = p.ty[i] - p.y[i];

      if (dx * dx + dy * dy <= reach * reach) {
        p.glyph[i] = p.pendingGlyph[i];
        const tier = p.pendingTier[i];
        p.tier[i] = tier;
        p.parallax[i] = this.layers[tier].parallax;
        p.pendingGlyph[i] = NO_PENDING;
      } else {
        remaining += 1;
      }
    }

    this.pendingCount = remaining;
  }
}
