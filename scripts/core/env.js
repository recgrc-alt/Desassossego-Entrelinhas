/**
 * @file env.js
 * Leitura do ambiente: capacidades do aparelho, preferências de quem o usa, e
 * tokens de desenho vindos do CSS.
 *
 * Existe para que nenhum outro módulo precise de tocar em matchMedia,
 * devicePixelRatio ou getComputedStyle. Quando o motor quer saber quantas
 * partículas pode desenhar, pergunta aqui.
 */

import { clamp } from './math.js';

/**
 * Teto do devicePixelRatio.
 *
 * Num telemóvel com DPR 3, desenhar à resolução nativa triplica a área de
 * preenchimento sem que o olho ganhe nada — as letras já são pequenas e já
 * têm anti-aliasing. Pior: o iOS Safari tem um teto global de memória de
 * canvas e, ao excedê-lo, descarta canvas em silêncio. Ficam brancos, sem
 * erro nenhum na consola, e o modo de falha é uma página vazia.
 */
const MAX_DPR = 2;

/**
 * Teto de área do buffer do palco, em píxeis do dispositivo. Entra em vigor
 * quando a área do ecrã vezes DPR² passa disto, baixando o DPR efetivo em vez
 * de recusar o canvas.
 */
const MAX_CANVAS_AREA_DESKTOP = 4194304;  // 2048²
const MAX_CANVAS_AREA_MOBILE = 2359296;   // 1536²

/** Orçamento de partículas num ecrã de referência de 1920×1080. */
const REFERENCE_AREA = 1920 * 1080;
const REFERENCE_BUDGET = 17000;

/**
 * Área mínima considerada no cálculo do orçamento, em píxeis de CSS.
 *
 * Uma página pode arrancar com o viewport a zero: num separador de segundo
 * plano, num painel de pré-visualização recolhido, num iframe ainda por
 * dimensionar. Medido assim, o orçamento cai para o mínimo — e como os
 * arrays tipados são reservados uma única vez no arranque, fica lá para
 * sempre, mesmo depois de a janela aparecer com o tamanho verdadeiro.
 *
 * O chão corresponde à mais pequena janela de browser realista. Numa janela
 * genuinamente pequena sobram algumas partículas invisíveis, que não custam
 * nada; num arranque sem dimensões, salva o site inteiro.
 */
const MIN_BUDGET_AREA = 640 * 480;

/** Nunca menos do que isto, ou um rosto deixa de se ler. */
const MIN_BUDGET = 1100;

/** Tetos medidos: o desenho por atlas aguenta muito mais em desktop do que
 *  no Safari do iPhone, onde cada drawImage custa quatro a cinco vezes mais. */
const MAX_BUDGET_DESKTOP = 16000;
const MAX_BUDGET_MOBILE = 3600;

/**
 * @typedef {object} LayerToken
 * @property {number} size Corpo do glifo em píxeis de CSS.
 * @property {number} opacity Opacidade do plano, em [0, 1].
 * @property {number} parallax Ganho de resposta ao cursor.
 */

/**
 * @typedef {object} Environment
 * @property {number} dpr Rácio de píxeis já limitado, por densidade e por área.
 * @property {boolean} reducedMotion
 * @property {boolean} coarsePointer Verdadeiro em ecrãs tácteis sem rato.
 * @property {boolean} canHover
 * @property {boolean} saveData
 * @property {number} particleBudget
 * @property {LayerToken[]} layers Os quatro planos de profundidade.
 * @property {{ min: number, max: number, comfort: number, lineHeight: number, tracking: number, opacity: number, gutter: number }} reading
 * @property {{ size: number, opacity: number }} word
 * @property {string} glyphColor
 * @property {string} fontFamily
 * @property {{ hold: number, fade: number, reveal: number }} introTiming
 */

/**
 * Lê uma variável CSS do :root como número.
 * @param {CSSStyleDeclaration} style
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function readNumber(style, name, fallback) {
  const raw = style.getPropertyValue(name).trim();
  if (raw === '') return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Lê uma duração CSS (`900ms` ou `0.9s`) em milissegundos.
 * @param {CSSStyleDeclaration} style
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function readDuration(style, name, fallback) {
  const raw = style.getPropertyValue(name).trim();
  if (raw === '') return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith('ms') ? value : value * 1000;
}

/**
 * Lê os quatro planos de profundidade declarados no CSS.
 * @param {CSSStyleDeclaration} style
 * @returns {LayerToken[]}
 */
function readLayers(style) {
  const defaults = [
    { size: 9, opacity: 0.17, parallax: 0.56 },
    { size: 12, opacity: 0.42, parallax: 0.75 },
    { size: 16, opacity: 0.63, parallax: 1 },
    { size: 22, opacity: 0.95, parallax: 1.38 },
  ];

  return defaults.map((fallback, index) => {
    const n = index + 1;
    return {
      size: readNumber(style, `--layer-${n}-size`, fallback.size),
      opacity: readNumber(style, `--layer-${n}-opacity`, fallback.opacity),
      parallax: readNumber(style, `--layer-${n}-parallax`, fallback.parallax),
    };
  });
}

/**
 * iPadOS mente sobre si próprio: o navigator.platform diz "MacIntel", igual a
 * um iMac. O que o distingue é ter pontos de toque.
 * @returns {boolean}
 */
function isTouchDevice() {
  return (navigator.maxTouchPoints || 0) > 1;
}

/**
 * Calcula o DPR efetivo: limitado pela densidade e, por cima disso, pela área
 * total do buffer que daria.
 * @param {boolean} mobile
 * @returns {number}
 */
function computeDpr(mobile) {
  const requested = clamp(window.devicePixelRatio || 1, 1, MAX_DPR);
  const maxArea = mobile ? MAX_CANVAS_AREA_MOBILE : MAX_CANVAS_AREA_DESKTOP;
  const cssArea = Math.max(1, window.innerWidth * window.innerHeight);

  const allowed = Math.sqrt(maxArea / cssArea);
  return clamp(Math.min(requested, allowed), 1, MAX_DPR);
}

/**
 * Calcula quantas partículas este aparelho aguenta.
 *
 * A conta parte da área do viewport em píxeis de CSS, e não em píxeis físicos:
 * o que determina quantas letras cabem a ler é o tamanho aparente do ecrã. O
 * DPR entra depois, como penalização, porque é ele que multiplica o custo de
 * preenchimento.
 *
 * Isto é só o ponto de partida. O governador de qualidade (ver
 * scripts/states/director.js) mede a cadência real e ajusta.
 *
 * @param {number} dpr
 * @param {boolean} reducedMotion
 * @param {boolean} mobile
 * @param {boolean} saveData
 * @returns {number}
 */
function computeBudget(dpr, reducedMotion, mobile, saveData) {
  const area = Math.max(MIN_BUDGET_AREA, window.innerWidth * window.innerHeight);
  const scaled = REFERENCE_BUDGET * (area / REFERENCE_AREA);

  // Cada passo de DPR acima de 1 custa cerca de 18% do orçamento.
  const dprPenalty = 1 - (dpr - 1) * 0.18;

  // Com movimento reduzido há um único fotograma a desenhar, mas também menos
  // razão para o encher: corta-se para pouco mais de metade.
  const motionFactor = reducedMotion ? 0.55 : 1;
  const dataFactor = saveData ? 0.6 : 1;

  const ceiling = mobile ? MAX_BUDGET_MOBILE : MAX_BUDGET_DESKTOP;
  return Math.round(clamp(scaled * dprPenalty * motionFactor * dataFactor, MIN_BUDGET, ceiling));
}

/**
 * Fotografa o ambiente atual.
 * @returns {Environment}
 */
export function readEnvironment() {
  const style = window.getComputedStyle(document.documentElement);

  const mobile = isTouchDevice();
  const dpr = computeDpr(mobile);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const canHover = window.matchMedia('(hover: hover)').matches;

  // Quem navega com poupança de dados ou pediu menos dados costuma estar
  // também com pouca bateria ou numa ligação fraca. Não é a mesma coisa que
  // movimento reduzido, mas é motivo para pesar menos.
  const saveData = Boolean(navigator.connection && navigator.connection.saveData)
    || window.matchMedia('(prefers-reduced-data: reduce)').matches;

  return {
    dpr,
    reducedMotion,
    coarsePointer,
    canHover,
    saveData,
    particleBudget: computeBudget(dpr, reducedMotion, mobile, saveData),
    layers: readLayers(style),
    reading: {
      min: readNumber(style, '--reading-min-size', 14),
      max: readNumber(style, '--reading-max-size', 21),
      comfort: readNumber(style, '--reading-comfort', 16),
      lineHeight: readNumber(style, '--reading-line-height', 1.95),
      tracking: readNumber(style, '--reading-tracking', 0.015),
      opacity: readNumber(style, '--reading-opacity', 1),
      gutter: readNumber(style, '--reading-gutter', 3.2),
    },
    word: {
      size: readNumber(style, '--word-size', 30),
      opacity: readNumber(style, '--word-opacity', 1),
    },
    glyphColor: style.getPropertyValue('--glyph-color').trim() || '#0e0e0e',
    fontFamily: style.getPropertyValue('--font-serif').trim() || 'Georgia, serif',
    introTiming: {
      hold: readDuration(style, '--intro-hold', 1500),
      fade: readDuration(style, '--intro-fade', 1100),
      reveal: readDuration(style, '--intro-reveal', 1400),
    },
  };
}

/**
 * Avisa quando a preferência por movimento reduzido muda a meio da sessão —
 * acontece quando alguém liga a definição no sistema com o separador aberto.
 *
 * @param {(reduced: boolean) => void} onChange
 * @returns {() => void} Cancela a subscrição.
 */
export function watchReducedMotion(onChange) {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  const handler = (event) => onChange(event.matches);

  // addEventListener em MediaQueryList só chegou ao Safari na versão 14; o
  // addListener antigo é a rede de segurança para iOS mais velho.
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', handler);
    return () => query.removeEventListener('change', handler);
  }

  query.addListener(handler);
  return () => query.removeListener(handler);
}

/**
 * Avisa quando a densidade do ecrã muda — zoom do browser, ou arrastar a
 * janela para um monitor com outra densidade.
 *
 * Uma media query de resolução é um valor fixo, não um observador: depois de
 * disparar uma vez, a query antiga deixa de servir e é preciso armar outra
 * com o valor novo. Daí a função voltar a chamar-se a si própria.
 *
 * @param {() => void} onChange
 * @returns {() => void} Cancela a subscrição.
 */
export function watchPixelRatio(onChange) {
  let dispose = () => {};

  const arm = () => {
    const current = window.devicePixelRatio || 1;
    const query = window.matchMedia(`(resolution: ${current}dppx)`);

    const handler = () => {
      dispose();
      arm();
      onChange();
    };

    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handler, { once: true });
      dispose = () => query.removeEventListener('change', handler);
    } else {
      query.addListener(handler);
      dispose = () => query.removeListener(handler);
    }
  };

  arm();
  return () => dispose();
}

/**
 * Espera que a tipografia esteja mesmo pronta.
 *
 * ESTE É O ERRO QUE MAIS CUSTA NUM PROJETO ASSIM, e é silencioso.
 *
 * document.fonts.ready resolve quando terminam os carregamentos EM CURSO — e
 * um canvas não conta como uso de fonte, por isso no arranque pode não haver
 * nenhum. Pior: a Google Fonts serve o EB Garamond partido em subconjuntos por
 * unicode-range, e o browser só pede o subconjunto onde estão o ã, o ç, o õ, o
 * í e o â quando encontra texto que os use. Chamar document.fonts.load sem
 * passar o texto pede apenas o subconjunto latino básico.
 *
 * O resultado de qualquer destes descuidos é o mesmo: o atlas de glifos é
 * rasterizado com a serifa de recurso do sistema, as métricas ficam erradas
 * para o resto da sessão, e nada aparece na consola. E só acontece em primeira
 * visita com cache fria — numa máquina onde o EB Garamond esteja instalado
 * localmente, o erro nunca se manifesta em desenvolvimento.
 *
 * Por isso: pedir explicitamente cada corpo de letra, passando o alfabeto
 * completo como texto, e confirmar no fim com document.fonts.check.
 *
 * O tempo limite existe porque um CDN em baixo — rede de empresa, país com
 * bloqueios — não pode significar um ecrã branco para sempre.
 *
 * @param {object} options
 * @param {string} options.fontFamily Pilha de fontes tal como vem do CSS.
 * @param {number[]} options.sizes Corpos a pedir, em píxeis.
 * @param {string} options.text Todos os caracteres que o site vai desenhar.
 * @param {number} [options.timeout]
 * @returns {Promise<boolean>} Verdadeiro se a fonte ficou mesmo disponível.
 */
export async function waitForFonts({ fontFamily, sizes, text, timeout = 4000 }) {
  if (!('fonts' in document)) return false;

  // Um spec de fonte sem tamanho é CSS inválido e lança SyntaxError em alguns
  // motores. Os corpos distintos chegam: o ficheiro é o mesmo, o que muda é
  // o pedido ser bem formado.
  const specs = Array.from(new Set(sizes.map((size) => `${Math.round(size)}px ${fontFamily}`)));

  const deadline = new Promise((resolve) => {
    window.setTimeout(() => resolve(false), timeout);
  });

  const loading = Promise.all(specs.map((spec) => document.fonts.load(spec, text)))
    .then(() => document.fonts.ready)
    .then(() => specs.every((spec) => document.fonts.check(spec, text)))
    .catch(() => false);

  return Promise.race([loading, deadline]);
}
