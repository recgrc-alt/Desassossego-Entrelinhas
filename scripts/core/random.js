/**
 * @file random.js
 * Aleatoriedade com semente.
 *
 * Math.random() não serve aqui por duas razões. A primeira é que a nuvem de
 * pontos de um rosto tem de ser sempre a mesma: se cada visita amostrasse a
 * fotografia de maneira diferente, um rosto podia sair bom e outro sair sujo,
 * e nenhum erro seria reproduzível. A segunda é a depuração — poder repetir
 * exatamente a mesma sessão vale mais do que a variedade.
 */

/**
 * mulberry32 — gerador de 32 bits, uma linha de estado, período de 2^32.
 * Escolhido por ser o melhor compromisso conhecido entre qualidade estatística
 * e custo: passa os testes gjrand, e cada chamada são três multiplicações.
 *
 * @param {number} seed Semente inteira.
 * @returns {() => number} Função que devolve um real em [0, 1).
 */
export function createRandom(seed) {
  let state = seed >>> 0;

  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Transforma um texto numa semente inteira (hash FNV-1a de 32 bits).
 * Permite semear a partir do identificador de um poeta, o que torna a nuvem
 * de pontos de cada rosto estável e distinta sem guardar números mágicos.
 *
 * @param {string} text
 * @returns {number}
 */
export function seedFrom(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Real em [min, max).
 * @param {() => number} random
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomRange(random, min, max) {
  return min + random() * (max - min);
}

/**
 * Elemento ao acaso de um array.
 * @template T
 * @param {() => number} random
 * @param {T[]} items
 * @returns {T}
 */
export function pick(random, items) {
  return items[Math.floor(random() * items.length) % items.length];
}
