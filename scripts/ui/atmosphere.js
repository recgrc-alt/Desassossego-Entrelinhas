/**
 * @file atmosphere.js
 * Luz circadiana.
 *
 * O site não muda de cor: muda de luz. O papel é sempre branco e a tipografia
 * é sempre preta — o que a hora do dia altera é a temperatura do branco, que
 * ao meio-dia se desloca para um creme pastel, como uma página ao sol, e à
 * noite volta ao neutro.
 *
 * Toda a mudança acontece numa única variável CSS, --warmth, em [0, 1]. A
 * mistura das duas superfícies é feita em CSS (ver variables.css) e em oklab,
 * para que a passagem entre o branco frio e o creme não atravesse cinzentos
 * sujos como aconteceria numa interpolação em sRGB.
 */

import { clamp } from '../core/math.js';

/** Hora a que a luz é mais quente. Treze e não doze: o pico térmico da luz
 *  natural vem depois do meio-dia solar, e é essa a sensação que se procura. */
const PEAK_HOUR = 13;

/** Metade da janela de luz, em horas. Com 6, o aquecimento começa às 7 e
 *  acaba às 19. */
const HALF_WINDOW = 6;

/** Expoente da curva. Acima de 1 aperta o pico à volta do meio-dia e deixa as
 *  manhãs e os fins de tarde quase neutros — que é como a luz se comporta. */
const CURVE = 1.6;

/** De quanto em quanto tempo se volta a ver as horas. Um minuto chega: a
 *  diferença de aquecimento entre dois minutos consecutivos é indetetável. */
const REFRESH_MS = 60 * 1000;

/**
 * Aquecimento para uma dada hora do dia.
 *
 * Meio cosseno centrado no pico: vale 1 à hora de pico, 0 nas pontas da
 * janela, e zero fora dela. Preferido a uma rampa linear porque chega e sai
 * de zero com derivada nula — não há um instante em que a cor "comece".
 *
 * @param {number} hours Hora decimal, ex.: 13.5 para as 13h30.
 * @returns {number} Em [0, 1].
 */
function warmthAt(hours) {
  const offset = (hours - PEAK_HOUR) / HALF_WINDOW;
  if (offset <= -1 || offset >= 1) return 0;
  const cosine = Math.cos(offset * (Math.PI / 2));
  return clamp(Math.pow(cosine, CURVE), 0, 1);
}

export class Atmosphere {
  /**
   * @param {HTMLElement} [root] Elemento onde a variável é escrita.
   */
  constructor(root = document.documentElement) {
    this.root = root;
    this.timer = 0;
    this.apply = this.apply.bind(this);
  }

  /**
   * Lê o relógio do sistema e escreve o aquecimento correspondente.
   *
   * É a única escrita em estilo que o JavaScript faz em todo o projeto, e é
   * deliberada: a hora não é exprimível em CSS. O que se escreve é um número
   * numa variável, não uma cor — a decisão sobre que creme é o creme continua
   * em variables.css.
   */
  apply() {
    const now = new Date();
    const hours = now.getHours() + now.getMinutes() / 60;
    this.root.style.setProperty('--warmth', warmthAt(hours).toFixed(4));
  }

  start() {
    this.apply();
    this.timer = window.setInterval(this.apply, REFRESH_MS);
  }

  stop() {
    window.clearInterval(this.timer);
    this.timer = 0;
  }
}
