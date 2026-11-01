/**
 * @file math.js
 * Funções matemáticas puras. Sem estado, sem efeitos secundários, sem
 * dependências — é o ficheiro mais baixo da pilha.
 *
 * Só tem duas coisas, e é de propósito: o que aqui estiver tem de ser usado.
 * Uma biblioteca de utilitários com vinte funções das quais se usam três é
 * código morto com boa apresentação. O suavizador de rampas e o filtro
 * exponencial que normalmente viveriam aqui estão escritos onde correm — no
 * ciclo quente da física — porque lá importa não haver uma chamada de função
 * por partícula e por fotograma.
 */

/**
 * Limita um valor a um intervalo.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Índice numa curva de Hilbert de ordem `order` para um ponto de grelha.
 *
 * Serve para resolver, de forma barata, o emparelhamento entre as partículas
 * que estão no ecrã e os alvos para onde têm de ir. Ordenar os dois conjuntos
 * pelo mesmo índice de Hilbert e emparelhá-los por posição na lista produz
 * trajetórias que quase não se cruzam, porque a curva preserva a vizinhança:
 * pontos próximos no plano ficam próximos na ordem. O custo é uma ordenação,
 * contra o O(n³) de uma atribuição ótima pelo método húngaro — e a diferença
 * visual, em movimento, não se nota.
 *
 * DUAS ARMADILHAS, as duas silenciosas:
 *
 * 1. A reflexão do quadrante usa o lado COMPLETO da grelha menos um
 *    (`side - 1 - px`), e não o lado do quadrante atual (`s - 1 - px`). É o
 *    erro mais comum nas transcrições deste algoritmo, e o pior: a curva
 *    continua a devolver índices plausíveis, mas perde a localidade em
 *    metade dos quadrantes. O sintoma — partículas a atravessar o ecrã de
 *    lado a lado numa transição — parece um problema de física e manda a
 *    depuração na direção errada.
 *
 * 2. `s * s * ((3 * rx) ^ ry)` tem de ficar em vírgula flutuante. Com ordens
 *    altas o produto excede os 32 bits, e um `| 0` posto aqui por hábito
 *    truncaria a chave.
 *
 * @param {number} order Número de bits por eixo. 10 dá uma grelha de
 *   1024×1024, mais fina do que qualquer ecrã precisa, e mantém o produto
 *   acima bem dentro da precisão exata dos inteiros em double.
 * @param {number} x Coordenada de grelha, inteiro em [0, 2^order).
 * @param {number} y Coordenada de grelha, inteiro em [0, 2^order).
 * @returns {number} Posição ao longo da curva.
 */
export function hilbertIndex(order, x, y) {
  const side = 1 << order;
  let px = x;
  let py = y;
  let d = 0;

  for (let s = side >> 1; s > 0; s >>= 1) {
    const rx = (px & s) > 0 ? 1 : 0;
    const ry = (py & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);

    // Rotação e reflexão do quadrante, para que a curva se mantenha contínua
    // ao atravessar as fronteiras entre quadrados.
    if (ry === 0) {
      if (rx === 1) {
        px = side - 1 - px;
        py = side - 1 - py;
      }
      const swap = px;
      px = py;
      py = swap;
    }
  }

  return d;
}
