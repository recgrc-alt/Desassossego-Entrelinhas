/**
 * @file words.js
 * As palavras que se formam e se desfazem no campo flutuante.
 *
 * De tempos a tempos, algumas letras que andavam à deriva reconhecem-se e
 * alinham-se numa palavra, em qualquer sítio do ecrã; passados uns segundos
 * voltam a soltar-se. É um acontecimento, não uma animação em ciclo: nunca
 * aparece no mesmo sítio, nunca dura o mesmo tempo, e as letras que a formam
 * são as que por acaso estavam ali perto.
 *
 * Vive em ficheiro próprio porque é a única parte do site que tem agenda: um
 * relógio que decide sozinho quando é que algo acontece. O resto do sistema
 * reage a ações do utilizador.
 */

import { createRandom, pick, randomRange } from '../core/random.js';
import { composeWord } from '../targets/text-sampler.js';

/**
 * O vocabulário do campo. Palavras curtas, portuguesas, do universo do
 * projeto — nada que precise de ser lido para ser compreendido.
 */
const FLOATING_WORDS = [
  'poesia',
  'literatura',
  'desassossego',
  'saudade',
  'entrelinhas',
  'verso',
  'palavra',
  'silêncio',
  'memória',
  'alma',
  'tempo',
  'sonho',
  'mar',
  'fingimento',
];

/** Intervalo entre palavras, em segundos. */
const GAP = { min: 2.2, max: 4.8 };

/**
 * Quanto tempo uma palavra se mantém formada, em segundos.
 *
 * Tem de dar para ler sem esforço e ainda sobrar tempo para a pessoa reparar
 * que ESTEVE ali. Abaixo de quatro segundos lê-se como um erro de render.
 */
const HOLD = { min: 4.4, max: 7.5 };

/** Quantas podem existir ao mesmo tempo. Acima de duas o ecrã deixa de ser um
 *  campo com acidentes e passa a ser uma lista. */
const MAX_CONCURRENT = 2;

/**
 * Velocidade com que as letras se afastam ao largar a palavra, em px/s.
 *
 * Sem isto, uma palavra desfeita limita-se a deixar de ser puxada, e as suas
 * letras ficam ali amontoadas até a corrente as separar — uns bons segundos
 * em que se vê a palavra por desmanchar. Com um empurrão de fora para dentro
 * invertido, a palavra abre-se, e abrir-se é o oposto legível de juntar-se.
 */
const BURST = 90;

/** Folga à volta da zona proibida, em píxeis. */
const KEEP_OUT_MARGIN = 24;

export class WordDance {
  /**
   * @param {object} options
   * @param {import('../particles/system.js').ParticleSystem} options.system
   * @param {import('../particles/atlas.js').GlyphAtlas} options.atlas
   * @param {number[]} options.tiers Planos de profundidade em que as palavras
   *   podem aparecer. Planos diferentes dão tamanhos diferentes, que é o que
   *   põe umas palavras mais perto e outras mais longe.
   * @param {string[]} [options.words]
   * @param {number} [options.seed]
   * @param {HTMLElement} [options.avoid] Elemento que as palavras não devem
   *   atravessar — na prática, o bloco do título e dos botões.
   */
  constructor({ system, atlas, tiers, words = FLOATING_WORDS, seed = 0x5eed, avoid = null }) {
    this.system = system;
    this.atlas = atlas;
    this.tiers = tiers;
    this.words = words;
    this.avoid = avoid;
    this.random = createRandom(seed);

    /** @type {{ word: string, indices: Uint32Array, remaining: number }[]} */
    this.active = [];
    this.cooldown = randomRange(this.random, 1.2, 2.4);
    this.enabled = false;
  }

  /** Liga o relógio. */
  start() {
    this.enabled = true;
    this.cooldown = randomRange(this.random, 0.8, 2);
  }

  /** Desliga o relógio e devolve ao campo tudo o que estava requisitado. */
  stop() {
    this.enabled = false;
    // Sem estalo: aqui a página está a mudar de etapa, e um grupo de letras a
    // explodir no meio da transição seria ruído.
    for (const event of this.active) {
      this.system.release(event.indices);
    }
    this.active.length = 0;
  }

  /**
   * Escolhe um sítio para uma palavra, fora do bloco central.
   *
   * A zona proibida é a caixa REAL do título e dos botões, lida do DOM, e não
   * um retângulo em frações do ecrã escrito à mão. Numa janela larga as duas
   * coisas coincidiriam; num telemóvel, onde o título passa a duas linhas e
   * os botões se empilham em quatro filas, o bloco ocupa metade da altura e
   * uma estimativa fixa deixava as palavras a aterrar-lhe em cima.
   *
   * A leitura do DOM acontece aqui, e não no ciclo de animação: uma palavra
   * nasce de poucos em poucos segundos, e forçar um cálculo de layout nesse
   * momento não custa nada.
   *
   * @private
   * @param {{ width: number, height: number }} viewport
   * @param {number} halfWidth Metade da largura estimada da palavra.
   * @param {number} halfHeight
   * @returns {{ x: number, y: number }}
   */
  placeAway(viewport, halfWidth, halfHeight) {
    const marginX = halfWidth + viewport.width * 0.04;
    const marginY = halfHeight + viewport.height * 0.06;

    const box = this.avoid ? this.avoid.getBoundingClientRect() : null;
    const maxX = Math.max(marginX, viewport.width - marginX);
    const maxY = Math.max(marginY, viewport.height - marginY);

    let x = randomRange(this.random, marginX, maxX);
    let y = randomRange(this.random, marginY, maxY);
    if (!box) return { x, y };

    const colide = (px, py) => px + halfWidth > box.left - KEEP_OUT_MARGIN
      && px - halfWidth < box.right + KEEP_OUT_MARGIN
      && py + halfHeight > box.top - KEEP_OUT_MARGIN
      && py - halfHeight < box.bottom + KEEP_OUT_MARGIN;

    for (let attempt = 0; attempt < 8 && colide(x, y); attempt += 1) {
      x = randomRange(this.random, marginX, maxX);
      y = randomRange(this.random, marginY, maxY);
    }

    if (!colide(x, y)) return { x, y };

    // Num telemóvel o bloco central ocupa a largura toda, por isso sortear
    // outra abcissa nunca resolve: a saída é SEMPRE por cima ou por baixo.
    // Em vez de continuar a tentar à sorte — e de acabar por aceitar uma
    // palavra em cima de um botão, que foi o que aconteceu — escolhe-se a
    // faixa livre maior e sorteia-se lá dentro.
    const acima = box.top - KEEP_OUT_MARGIN - halfHeight - marginY;
    const abaixo = maxY - (box.bottom + KEEP_OUT_MARGIN + halfHeight);

    if (acima <= 0 && abaixo <= 0) return { x, y };

    y = acima > abaixo
      ? randomRange(this.random, marginY, box.top - KEEP_OUT_MARGIN - halfHeight)
      : randomRange(this.random, box.bottom + KEEP_OUT_MARGIN + halfHeight, maxY);

    return { x, y };
  }

  /**
   * @private
   * @param {{ width: number, height: number }} viewport
   */
  spawn(viewport) {
    // Nunca a mesma palavra duas vezes ao mesmo tempo. Com duas em cena e
    // catorze no vocabulário, o acaso repetia-se com frequência suficiente
    // para se notar — e duas "fingimento" em cantos opostos do ecrã lêem-se
    // como erro, não como coincidência.
    let word = pick(this.random, this.words);
    for (let tentativa = 0; tentativa < 6; tentativa += 1) {
      if (!this.active.some((event) => event.word === word)) break;
      word = pick(this.random, this.words);
    }

    const tier = pick(this.random, this.tiers);

    // Medidas estimadas antes de compor, só para escolher um sítio onde a
    // palavra caiba: um carácter médio desta serifa ronda meio corpo de letra.
    const body = this.atlas.sizes[tier];
    const estimated = word.length * body * 0.52;
    const spot = this.placeAway(viewport, estimated / 2, body);

    const targets = composeWord(word, {
      atlas: this.atlas,
      tier,
      centreX: spot.x,
      centreY: spot.y,
    });

    if (targets.length === 0) return;

    const indices = this.system.assignNearest(targets);
    this.active.push({
      word,
      indices,
      remaining: randomRange(this.random, HOLD.min, HOLD.max),
    });
  }

  /**
   * @param {number} dt Segundos.
   * @param {{ width: number, height: number }} viewport
   */
  update(dt, viewport) {
    // Percorrido de trás para a frente: remover a meio de um ciclo ascendente
    // saltaria o elemento seguinte.
    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const event = this.active[i];
      event.remaining -= dt;
      if (event.remaining <= 0) {
        this.system.release(event.indices, { burst: BURST });
        this.active.splice(i, 1);
      }
    }

    if (!this.enabled) return;

    this.cooldown -= dt;
    if (this.cooldown > 0 || this.active.length >= MAX_CONCURRENT) return;

    this.spawn(viewport);
    this.cooldown = randomRange(this.random, GAP.min, GAP.max);
  }
}
