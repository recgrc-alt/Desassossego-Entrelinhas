/**
 * @file weighted-sampler.js
 * Amostragem por importância, estratificada, com quotas exatas.
 *
 * Dado um campo de pesos — uma grelha em que cada célula diz "quanta tinta há
 * aqui" — devolve exatamente N pontos distribuídos com densidade proporcional
 * ao peso, sem se amontoarem uns em cima dos outros.
 *
 * É o mesmo algoritmo para a fotografia de um poeta e para as letras da
 * saudação de entrada: num caso o campo de pesos vem da escuridão da imagem,
 * no outro da tinta dos glifos. Ter duas versões do mesmo problema para
 * manter em sincronia seria pedir que divergissem.
 *
 * ---------------------------------------------------------------------------
 * PORQUÊ ASSIM E NÃO DE OUTRA MANEIRA
 *
 * O critério não é o tom médio ficar certo — é o resultado LER como um rosto
 * quando desenhado com letras de nove a vinte e dois píxeis. O que estraga
 * essa leitura é aglomeração e buracos, não erro tonal.
 *
 *   Grelha regular com rejeição — os glifos alinham-se em colunas e o rosto
 *   parece uma tabela. E a densidade fica binária: a célula tem ou não tem.
 *
 *   Rejeição pura sobre a soma acumulada — produz ruído branco. A distância
 *   ao vizinho mais próximo fica com distribuição exponencial, por isso há
 *   pares a um píxel e vazios de quarenta. Com glifos de doze píxeis isso lê
 *   como sujidade, não como pele.
 *
 *   Poisson-disk de Bridson ponderado — a melhor distribuição de todas, mas o
 *   raio variável obriga a uma grelha de aceleração multi-resolução e a
 *   rejeições em cascata nas transições de densidade. Encosta ao teto de
 *   tempo.
 *
 *   Difusão de erro (Floyd-Steinberg) — preserva o tom perfeitamente, mas
 *   prende os pontos a coordenadas inteiras, deixa os "vermes" caraterísticos
 *   da varredura em serpentina, e não permite pedir um número exato.
 *
 *   Relaxação de Lloyd sobre Voronoi ponderado — o padrão-ouro estético, e
 *   centenas de milissegundos. Fora de questão no caminho de um clique.
 *
 * O que está implementado aqui é um híbrido que herda o essencial de três
 * deles por uma fração do custo:
 *
 *   1. ESTRATIFICAÇÃO. Uma grelha de estratos dimensionada para cerca de 1.3
 *      pontos por estrato — o regime em que uma grelha com jitter já é, na
 *      prática, ruído azul.
 *   2. QUOTAS POR MAIORES RESTOS. O número de pontos de cada estrato é
 *      proporcional à tinta que lá está, e a soma dá N exato por construção
 *      aritmética, sem um único ciclo de tentativa e erro sobre limiares.
 *      É a mesma preservação de tom da difusão de erro, sem os vermes.
 *   3. MELHOR DE CINCO CANDIDATOS (Mitchell). Dentro do estrato sorteiam-se
 *      cinco posições e fica a que estiver mais longe do vizinho já colocado
 *      mais próximo. Empurra o espetro para perto do Poisson-disk sem
 *      nenhum ciclo de relaxação. Com k = 1 voltaríamos ao ruído branco; com
 *      k = 10 melhora uns quatro por cento e custa o dobro.
 */

import { clamp } from '../core/math.js';
import { createRandom } from '../core/random.js';

/** Candidatos avaliados por ponto. */
const CANDIDATES = 5;

/** Tentativas de rejeição por candidato antes de aceitar o que houver. */
const TRIES = 24;

/** Pontos por estrato, em média. 1.3 é o regime de grelha com jitter. */
const POINTS_PER_STRATUM = 1.25;

/** Limites do número de estratos por eixo. */
const MIN_STRATA = 12;
const MAX_STRATA = 96;

/**
 * @param {Float32Array} weights Campo de pesos, linha a linha, não negativo.
 * @param {number} width Largura da grelha, em células.
 * @param {number} height Altura da grelha, em células.
 * @param {number} count Pontos pretendidos.
 * @param {number} seed
 * @returns {Float32Array} Pares x,y em coordenadas de célula com fração.
 *   O comprimento é `count * 2` salvo se o campo for tão ralo que não haja
 *   onde pôr os pontos todos.
 */
export function sampleWeighted(weights, width, height, count, seed) {
  if (count <= 0) return new Float32Array(0);

  const random = createRandom(seed);

  // --- Estratos -----------------------------------------------------------
  const strata = clamp(Math.round(Math.sqrt(count / POINTS_PER_STRATUM)), MIN_STRATA, MAX_STRATA);
  const strataCount = strata * strata;
  const cellW = width / strata;
  const cellH = height / strata;

  const sums = new Float64Array(strataCount);
  const peaks = new Float32Array(strataCount);
  let total = 0;

  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(strata - 1, (y / cellH) | 0);
    const rowBase = y * width;
    const strataRow = sy * strata;

    for (let x = 0; x < width; x += 1) {
      const w = weights[rowBase + x];
      if (w <= 0) continue;

      const s = strataRow + Math.min(strata - 1, (x / cellW) | 0);
      sums[s] += w;
      if (w > peaks[s]) peaks[s] = w;
      total += w;
    }
  }

  if (total <= 0) return new Float32Array(0);

  // --- Quotas por maiores restos ------------------------------------------
  // floor de cada quota, e os lugares que sobram vão para os estratos com
  // maior parte fracionária. A soma é N exato por construção: nunca é preciso
  // procurar um limiar que "dê mais ou menos o número certo de pontos".
  const quotas = new Int32Array(strataCount);
  const remainders = [];
  let assigned = 0;

  for (let s = 0; s < strataCount; s += 1) {
    if (sums[s] <= 0) continue;
    const exact = (count * sums[s]) / total;
    const whole = Math.floor(exact);
    quotas[s] = whole;
    assigned += whole;
    remainders.push({ s, frac: exact - whole });
  }

  // Desempate explícito pelo índice: dois estratos com a mesma parte
  // fracionária trocariam de ordem entre motores de JavaScript e a nuvem
  // deixaria de ser a mesma em todos os browsers.
  remainders.sort((a, b) => (b.frac - a.frac) || (a.s - b.s));

  for (let k = 0; assigned < count && k < remainders.length; k += 1) {
    quotas[remainders[k].s] += 1;
    assigned += 1;
  }

  // --- Grelha de vizinhança para o melhor-de-cinco ------------------------
  const spacing = Math.max(1, Math.sqrt((width * height) / count) * 0.75);
  const columns = Math.max(1, Math.ceil(width / spacing));
  const rows = Math.max(1, Math.ceil(height / spacing));
  const occupancy = new Int32Array(columns * rows).fill(-1);

  const points = new Float32Array(count * 2);
  let placed = 0;

  for (let s = 0; s < strataCount && placed < count; s += 1) {
    const quota = quotas[s];
    if (quota <= 0) continue;

    const sx = (s % strata) * cellW;
    const sy = ((s / strata) | 0) * cellH;
    const peak = peaks[s];
    if (peak <= 0) continue;

    for (let q = 0; q < quota && placed < count; q += 1) {
      let bestX = 0;
      let bestY = 0;
      let bestDistance = -1;

      for (let c = 0; c < CANDIDATES; c += 1) {
        // Rejeição ponderada dentro do estrato: sorteia-se uma posição e
        // aceita-se com probabilidade igual ao peso relativo ao máximo local.
        // Normalizar pelo máximo LOCAL e não global é o que mantém a taxa de
        // aceitação alta mesmo num estrato todo escuro ou todo claro.
        let cx = sx + random() * cellW;
        let cy = sy + random() * cellH;

        for (let t = 0; t < TRIES; t += 1) {
          const px = Math.min(width - 1, Math.max(0, Math.floor(cx)));
          const py = Math.min(height - 1, Math.max(0, Math.floor(cy)));
          if (random() * peak <= weights[py * width + px]) break;
          cx = sx + random() * cellW;
          cy = sy + random() * cellH;
        }

        // Distância ao vizinho já colocado mais próximo, nas nove células em
        // volta. Fica o candidato que estiver mais sozinho.
        const gx = clamp(Math.floor(cx / spacing), 0, columns - 1);
        const gy = clamp(Math.floor(cy / spacing), 0, rows - 1);
        let nearest = Infinity;

        for (let oy = -1; oy <= 1; oy += 1) {
          const ny = gy + oy;
          if (ny < 0 || ny >= rows) continue;
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = gx + ox;
            if (nx < 0 || nx >= columns) continue;
            const other = occupancy[ny * columns + nx];
            if (other < 0) continue;

            const dx = points[other * 2] - cx;
            const dy = points[other * 2 + 1] - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 < nearest) nearest = d2;
          }
        }

        if (nearest > bestDistance) {
          bestDistance = nearest;
          bestX = cx;
          bestY = cy;
        }
      }

      points[placed * 2] = bestX;
      points[placed * 2 + 1] = bestY;

      const gx = clamp(Math.floor(bestX / spacing), 0, columns - 1);
      const gy = clamp(Math.floor(bestY / spacing), 0, rows - 1);
      occupancy[gy * columns + gx] = placed;
      placed += 1;
    }
  }

  return placed === count ? points : points.subarray(0, placed * 2);
}
