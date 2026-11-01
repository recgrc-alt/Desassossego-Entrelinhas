/**
 * @file image-sampler.js
 * Converte uma fotografia numa nuvem de pontos com a densidade de um rosto.
 *
 * O PROBLEMA
 * Uma fotografia de 700×700 tem meio milhão de píxeis; o ecrã comporta alguns
 * milhares de letras. A pergunta não é "que píxeis são escuros" — é "onde é
 * que três mil pontos têm de estar para que o olho veja aquela cara". São
 * coisas diferentes: limiarizar a imagem e aceitar tudo o que é escuro enche
 * o cabelo e o casaco e deixa o rosto, que é meio-tom, praticamente vazio.
 *
 * O PIPELINE, e a razão de cada passo:
 *
 *   1. LUMINÂNCIA Rec.709 sobre os bytes como estão, SEM linearizar. Este é o
 *      passo onde é mais fácil errar. Um cinzento sRGB a 50% (byte 128) tem
 *      luminância linear de 0.216 — linearizar daria escuridão 0.78 e encheria
 *      todos os meios-tons de glifos, chapando o rosto numa mancha. A luma
 *      com gama aproxima a resposta do olho, e é por isso que a distribuição
 *      se parece com o que se vê na fotografia.
 *
 *   2. DESFOQUE 1-2-1. Barato, separável, e indispensável antes do Sobel: sem
 *      ele o detetor de arestas amplifica o grão da película e os artefactos
 *      de compressão, e espalha letras pelo fundo branco. É o erro mais
 *      visível de todo o pipeline.
 *
 *   3. NÍVEIS AUTOMÁTICOS POR QUANTIS, e não um limiar absoluto. Um limiar
 *      fixo faz o número de pontos variar uma ordem de grandeza entre uma
 *      fotografia contrastada e uma subexposta. Os quantis dizem onde começa
 *      o preto e onde começa o branco NESTA imagem, sejam quais forem os
 *      cinco retratos que um dia venham a estar na pasta.
 *
 *   4. SOBEL, com peso misto: multiplicativo E aditivo. O multiplicativo
 *      adensa arestas que já estão em zona escura — a íris, a sombra da
 *      narina. O aditivo é o que salva a silhueta: o contorno contra o fundo
 *      branco é, por definição, um sítio onde a escuridão já caiu a zero, e
 *      multiplicativamente não receberia nada. Sem este termo o resultado é
 *      uma nuvem com a forma certa e sem feições — uma mancha, não uma cara.
 *      A normalização é pelo percentil 99 e não pelo máximo: um único píxel
 *      de ruído definiria o máximo e colapsaria todo o resto.
 *
 *   5. AMOSTRAGEM por quotas estratificadas (ver weighted-sampler.js).
 */

import { clamp } from '../core/math.js';
import { sampleWeighted } from './weighted-sampler.js';

/**
 * Lado da grelha de trabalho.
 *
 * As fotografias são 700×700 e são desenhadas sem reescala: cada algoritmo de
 * reamostragem difere entre Chrome, Firefox e Safari, e reescalar destruiria
 * a garantia de a mesma imagem dar sempre a mesma nuvem. Meio milhão de
 * píxeis percorridos cinco vezes custa 25 a 35 ms, uma vez por poeta e com
 * resultado em cache.
 */
const WORK_SIZE = 700;

/** Quantis dos níveis automáticos: onde começa o preto, onde começa o branco. */
const LEVEL_LOW = 0.02;
const LEVEL_HIGH = 0.75;

/**
 * Acima desta fração de píxeis com tinta suspeita-se de que o fundo da
 * fotografia não é branco. É um aviso, não uma recusa: uma fotografia com
 * fundo escuro é uma escolha legítima de quem a preparou.
 *
 * O limiar começou em 0.6 e disparava no retrato da Sophia, que tem 64% de
 * área com peso — um rosto claro, de frente, a ocupar quase todo o
 * enquadramento — e que compõe perfeitamente. Um aviso que aparece em todas
 * as visitas por causa de uma fotografia boa é ruído, e ruído na consola
 * ensina a ignorá-la.
 */
const BACKGROUND_ALARM = 0.78;

/**
 * Abaixo desta amplitude tonal a leitura não tem informação nenhuma.
 *
 * Não é o mesmo que um fundo escuro. É o caso em que os píxeis saem todos
 * praticamente iguais — o que acontece quando o browser recusa dar a
 * fotografia: o Firefox com privacy.resistFingerprinting e o Tor Browser
 * devolvem um canvas achatado em vez de lançarem erro, e a função nem dá por
 * ela. Sem este teste o resultado é um retângulo uniforme de letras grandes a
 * cobrir o ecrã, com o painel a anunciar que está a compor um rosto.
 */
const FLAT_READING_RANGE = 0.02;

/**
 * Expoente da escuridão. ABAIXO de 1, de propósito.
 *
 * O instinto manda subir este número para "dar mais contraste". Com estas
 * fotografias faz exatamente o contrário do que é preciso. Medido no retrato
 * de Pessoa: 47% da imagem é branco puro e mais de um quarto é preto
 * absoluto — o chapéu e o casaco estão esmagados em zero, sem um único
 * pormenor lá dentro. Com expoente 1.6, o chapéu recebia nove vezes mais
 * letras por píxel do que a cara, e o resultado era uma mancha sólida em cima
 * de um triângulo sólido, com um buraco branco no meio onde devia estar um
 * rosto.
 *
 * Um expoente abaixo de 1 comprime essa razão para cerca de 2.4 para 1: o
 * preto continua a ser o mais denso, mas deixa de monopolizar as quotas, e
 * os meios-tons da face — que são onde está toda a informação — recebem
 * letras suficientes para modelar o volume.
 */
const DARKNESS_GAMMA = 0.78;

/** Reforço multiplicativo das arestas: adensa os contornos que já estão em
 *  zona escura — a íris, a sombra da narina, o aro dos óculos. */
const EDGE_MULTIPLY = 1.2;

/**
 * Reforço ADITIVO das arestas, e é este que faz a diferença entre um rosto e
 * uma mancha com a forma certa.
 *
 * A silhueta contra o fundo branco é, por definição, um sítio onde a
 * escuridão já caiu a zero: multiplicativamente não receberia nada. Somado,
 * recebe uma linha nítida. O mesmo vale para a pálpebra, a linha do lábio e o
 * contorno do nariz, que são transições e não zonas escuras.
 */
const EDGE_ADD = 0.7;

/**
 * Teto do termo tonal, e a decisão que mais mudou o resultado.
 *
 * Metade de uma destas fotografias é preto absoluto: o chapéu e o casaco são
 * massas chapadas, sem um único pormenor lá dentro. Sem este teto, a conta
 * tonal manda para lá a maior parte dos pontos — e cada ponto gasto a
 * preencher um chapéu liso é um ponto que falta na cara, que é onde está
 * tudo o que importa num retrato.
 *
 * Com o teto, uma zona chapada recebe apenas o suficiente para ler como
 * sólida, e a diferença entre o chapéu e a face passa a ser decidida pelos
 * contornos, que é onde está a informação. Não é uma reprodução tonal fiel —
 * é uma gravura, e uma gravura também não distribui o buril por igual.
 *
 * O tom com que cada letra é DESENHADA continua a ser o verdadeiro: a
 * escuridão real é guardada à parte, e é dela que sai o corpo do glifo (ver
 * `darkness` em buildWeights e tierForTone em states/director.js). Separar o
 * "onde pôr" do "quão escuro" é o que permite ter as duas coisas.
 */
const FLAT_CEILING = 0.6;

/** Teto do peso total de um píxel, para que uma aresta muito marcada não
 *  monopolize a quota do seu estrato. */
const WEIGHT_CEILING = 2.2;

/**
 * Abaixo disto o píxel é fundo e sai do sorteio.
 *
 * Com o expoente acima, 0.1 corresponde a descartar tudo o que seja mais
 * claro do que 82% de branco — ou seja, as zonas iluminadas da testa e da
 * face. É deliberado: num retrato a tinta sobre papel, a luz é o papel.
 */
const WEIGHT_FLOOR = 0.1;

/** Bins do histograma usado nos quantis e no percentil das arestas. */
const BINS = 1024;

/** Nuvens já calculadas, em coordenadas normalizadas — por isso sobrevivem a
 *  redimensionamentos e só se calculam uma vez por poeta. */
const cache = new Map();

/**
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Não foi possível carregar a imagem: ${src}`));
    // crossOrigin NÃO é definido: as imagens são servidas da mesma origem que
    // a página. Defini-lo contra um servidor que não envie
    // Access-Control-Allow-Origin faz a imagem falhar por completo, o que é
    // pior do que a contaminação que evitaria.
    image.src = src;
  });
}

/**
 * Campo de luminância da imagem.
 * @param {HTMLImageElement} image
 * @returns {Float32Array}
 */
function buildLuminance(image) {
  const canvas = document.createElement('canvas');
  canvas.width = WORK_SIZE;
  canvas.height = WORK_SIZE;

  // willReadFrequently mantém o buffer na memória do processador. Sem isto,
  // cada getImageData força uma leitura de volta da GPU — 20 a 60 ms de
  // paragem num canvas deste tamanho. As opções só valem na primeira chamada
  // a getContext deste canvas; uma segunda devolve o mesmo contexto e
  // ignora-as em silêncio.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Contexto 2D indisponível para analisar a imagem.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WORK_SIZE, WORK_SIZE);
  ctx.drawImage(image, 0, 0, WORK_SIZE, WORK_SIZE);

  let data;
  try {
    data = ctx.getImageData(0, 0, WORK_SIZE, WORK_SIZE).data;
  } catch (error) {
    // Canvas contaminado. Acontece se a página for aberta em file:// ou se a
    // imagem vier de outra origem sem cabeçalhos de CORS.
    canvas.width = 1;
    canvas.height = 1;
    throw new Error(
      'O canvas ficou contaminado e os píxeis da fotografia não podem ser lidos. '
      + 'Isto acontece quando a página é aberta diretamente do disco (file://): '
      + 'é preciso servi-la por HTTP. Ver o README.',
      { cause: error },
    );
  }

  const luma = new Float32Array(WORK_SIZE * WORK_SIZE);

  for (let i = 0, p = 0; i < luma.length; i += 1, p += 4) {
    // O alfa é composto sobre branco: um PNG recortado tem de ler como papel,
    // não como tinta, ou o retrato vira uma mancha sólida.
    const a = data[p + 3] / 255;
    const r = data[p] * a + 255 * (1 - a);
    const g = data[p + 1] * a + 255 * (1 - a);
    const b = data[p + 2] * a + 255 * (1 - a);

    // Rec.709: os coeficientes do espaço sRGB, que é onde os ficheiros vivem.
    // Os do Rec.601 vêm dos primários do NTSC de 1953 e fazem uma zona
    // avermelhada ler mais clara do que é. Numa fotografia genuinamente a
    // preto e branco os dois dão o mesmo — mas o correto não custa mais.
    luma[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  // Encolher já o canvas de trabalho: num iPhone, cinco destes vivos ao mesmo
  // tempo chegam para esgotar o orçamento de memória de canvas do Safari.
  canvas.width = 1;
  canvas.height = 1;

  return luma;
}

/**
 * Desfoque gaussiano aproximado por um núcleo 1-2-1 separável.
 * @param {Float32Array} field
 * @param {number} size
 * @returns {Float32Array}
 */
function blur121(field, size) {
  const temp = new Float32Array(field.length);
  const out = new Float32Array(field.length);

  for (let y = 0; y < size; y += 1) {
    const row = y * size;
    for (let x = 0; x < size; x += 1) {
      const left = field[row + (x > 0 ? x - 1 : 0)];
      const mid = field[row + x];
      const right = field[row + (x < size - 1 ? x + 1 : size - 1)];
      temp[row + x] = (left + 2 * mid + right) * 0.25;
    }
  }

  for (let y = 0; y < size; y += 1) {
    const row = y * size;
    const up = (y > 0 ? y - 1 : 0) * size;
    const down = (y < size - 1 ? y + 1 : size - 1) * size;
    for (let x = 0; x < size; x += 1) {
      out[row + x] = (temp[up + x] + 2 * temp[row + x] + temp[down + x]) * 0.25;
    }
  }

  return out;
}

/**
 * Quantis de um campo, por histograma.
 *
 * Um histograma de mil bins sobre meio milhão de valores custa O(n); ordenar
 * para encontrar o mesmo quantil seria O(n log n) e muito mais memória.
 *
 * @param {Float32Array} field Valores em [0, 1].
 * @param {number[]} quantiles
 * @returns {number[]}
 */
function quantilesOf(field, quantiles) {
  const histogram = new Uint32Array(BINS);
  for (let i = 0; i < field.length; i += 1) {
    const bin = clamp((field[i] * BINS) | 0, 0, BINS - 1);
    histogram[bin] += 1;
  }

  const out = [];
  let cursor = 0;
  let running = 0;

  for (const q of quantiles) {
    const threshold = q * field.length;
    while (cursor < BINS - 1 && running + histogram[cursor] < threshold) {
      running += histogram[cursor];
      cursor += 1;
    }
    out.push(cursor / BINS);
  }

  return out;
}

/**
 * Campos de peso e de escuridão.
 *
 * Saem os dois do mesmo passo porque partilham os níveis automáticos e o
 * Sobel, mas servem para coisas diferentes: `weights` decide ONDE caem os
 * pontos, `darkness` decide com que PESO cada um é desenhado.
 *
 * @param {Float32Array} luma Já desfocado.
 * @param {number} size
 * @returns {{ weights: Float32Array, darkness: Float32Array, coverage: number, range: number }}
 */
function buildWeights(luma, size) {
  const [low, high] = quantilesOf(luma, [LEVEL_LOW, LEVEL_HIGH]);
  const span = Math.max(0.05, high - low);

  // --- Magnitude do gradiente (Sobel) ------------------------------------
  const gradient = new Float32Array(size * size);
  let maxGradient = 0;

  for (let y = 1; y < size - 1; y += 1) {
    const row = y * size;
    for (let x = 1; x < size - 1; x += 1) {
      const i = row + x;
      const tl = luma[i - size - 1];
      const t = luma[i - size];
      const tr = luma[i - size + 1];
      const l = luma[i - 1];
      const r = luma[i + 1];
      const bl = luma[i + size - 1];
      const b = luma[i + size];
      const br = luma[i + size + 1];

      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      // sqrt e não |gx| + |gy|: a soma dos módulos é 15% mais rápida e torna
      // as arestas diagonais 41% mais fortes que as ortogonais, o que inclina
      // visivelmente a distribuição.
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      gradient[i] = magnitude;
      if (magnitude > maxGradient) maxGradient = magnitude;
    }
  }

  // Normalização pelo percentil 99 do gradiente, não pelo máximo.
  let edgeScale = 1;
  if (maxGradient > 0) {
    const normalized = new Float32Array(gradient.length);
    for (let i = 0; i < gradient.length; i += 1) normalized[i] = gradient[i] / maxGradient;
    const [p99] = quantilesOf(normalized, [0.99]);
    edgeScale = 1 / Math.max(0.02, p99 * maxGradient);
  }

  // --- Pesos e escuridão --------------------------------------------------
  const weights = new Float32Array(size * size);
  const darkness = new Float32Array(size * size);
  let live = 0;

  for (let i = 0; i < weights.length; i += 1) {
    const level = clamp((luma[i] - low) / span, 0, 1);
    const dark = 1 - level;
    const edge = Math.min(1, gradient[i] * edgeScale);

    darkness[i] = dark;

    const tonal = Math.min(FLAT_CEILING, Math.pow(dark, DARKNESS_GAMMA));
    const weight = Math.min(
      WEIGHT_CEILING,
      tonal * (1 + EDGE_MULTIPLY * edge) + EDGE_ADD * edge,
    );

    if (weight < WEIGHT_FLOOR) continue;
    weights[i] = weight;
    live += 1;
  }

  return { weights, darkness, coverage: live / weights.length, range: high - low };
}

/**
 * Cede a vez ao browser.
 *
 * O pipeline inteiro são 25 a 35 ms, que cabem com folga nos 150 ms de
 * orçamento — mas num único bloco síncrono chegam para perder dois fotogramas
 * no instante exato em que alguém acabou de clicar e está a olhar. Partido em
 * fases, o trabalho é o mesmo e o salto desaparece.
 *
 * requestAnimationFrame e não setTimeout(0): em separadores de segundo plano
 * o setTimeout é travado a um segundo e o arranque ficaria pendurado.
 *
 * @returns {Promise<void>}
 */
function yieldToBrowser() {
  return new Promise((resolve) => {
    let entregue = false;
    const seguir = () => {
      if (entregue) return;
      entregue = true;
      resolve();
    };

    // O fotograma é o momento certo para retomar quando a página está a ser
    // pintada. Quando não está — um separador em segundo plano, uma janela
    // minimizada, um painel recolhido — o browser suspende o
    // requestAnimationFrame por completo e o fotograma nunca chega. Sem o
    // segundo caminho, uma análise iniciada nessas condições fica pendurada
    // para sempre, e com ela tudo o que a espere.
    window.requestAnimationFrame(seguir);
    window.setTimeout(seguir, 32);
  });
}

/**
 * @typedef {object} Cloud
 * @property {Float32Array} xy Pares x,y em [0, 1].
 * @property {Float32Array} tone Peso de cada ponto, normalizado a [0, 1].
 *   É com isto que o rosto ganha feições: quem recebe o ponto escolhe o
 *   tamanho da letra em função deste valor, e o contraste passa a vir também
 *   do corpo do glifo e não só da densidade. Com densidade sozinha, a uma
 *   dúzia de píxeis de espaçamento, um olho e uma face lêem-se iguais.
 */

/**
 * Amostra uma fotografia e devolve a nuvem normalizada.
 *
 * @param {string} src Caminho da imagem.
 * @param {object} options
 * @param {number} options.count Número de pontos pretendido.
 * @param {number} options.seed Semente: a mesma imagem dá sempre o mesmo desenho.
 * @returns {Promise<Cloud>}
 */
export async function sampleImage(src, { count, seed }) {
  const key = `${src}|${count}|${seed}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const image = await loadImage(src);

  const raw = buildLuminance(image);
  await yieldToBrowser();

  const smooth = blur121(raw, WORK_SIZE);
  await yieldToBrowser();

  const { weights, darkness, coverage, range } = buildWeights(smooth, WORK_SIZE);
  await yieldToBrowser();

  // Leitura achatada: não há rosto nenhum ali dentro. Parar aqui é melhor do
  // que desenhar um retângulo de letras e chamar-lhe retrato — quem chamou
  // esta função trata a exceção e diz que os poemas estão em texto.
  if (range < FLAT_READING_RANGE && coverage > 0.9) {
    throw new Error(
      'A fotografia foi lida sem contraste nenhum. Isto acontece quando o '
      + 'browser recusa devolver os píxeis de um canvas — o Firefox com '
      + 'privacy.resistFingerprinting e o Tor Browser fazem-no sem lançar erro. '
      + 'A antologia em texto não depende disto.',
    );
  }

  if (coverage > BACKGROUND_ALARM) {
    // Mais de metade da imagem com tinta significa quase de certeza que o
    // fundo não é branco — uma vinheta, um cinzento, uma moldura escura. Os
    // pontos vão espalhar-se pelo retângulo todo e o rosto não se lê.
    console.warn(
      `[amostrador] ${src}: ${Math.round(coverage * 100)}% da imagem tem peso. `
      + 'O fundo provavelmente não é branco puro e o retrato vai sair espalhado.',
    );
  }

  const cells = sampleWeighted(weights, WORK_SIZE, WORK_SIZE, count, seed);

  // De coordenadas de célula para [0, 1], e o peso de cada ponto colhido no
  // sítio onde ele caiu.
  const total = cells.length / 2;
  const xy = new Float32Array(cells.length);
  const tone = new Float32Array(total);

  for (let i = 0; i < total; i += 1) {
    const cx = cells[i * 2];
    const cy = cells[i * 2 + 1];
    xy[i * 2] = cx / WORK_SIZE;
    xy[i * 2 + 1] = cy / WORK_SIZE;

    const px = Math.min(WORK_SIZE - 1, Math.max(0, Math.floor(cx)));
    const py = Math.min(WORK_SIZE - 1, Math.max(0, Math.floor(cy)));

    // A ESCURIDÃO verdadeira, não o peso de amostragem. O peso foi limitado
    // de propósito nas massas chapadas para não gastar lá os pontos todos;
    // usá-lo aqui faria o chapéu ser desenhado com a mesma letra que a face,
    // e perdia-se o preto.
    tone[i] = darkness[py * WORK_SIZE + px];
  }

  const cloud = { xy, tone };
  cache.set(key, cloud);
  return cloud;
}

/**
 * Projeta uma nuvem normalizada no ecrã, centrada e com a proporção mantida.
 *
 * @param {Cloud} cloud
 * @param {object} frame
 * @param {number} frame.width Largura do viewport, em píxeis de CSS.
 * @param {number} frame.height Altura do viewport, em píxeis de CSS.
 * @param {number} [frame.scale] Fração do lado menor ocupada pelo retrato.
 * @param {number} [frame.offsetY] Deslocamento vertical, em fração da altura.
 * @returns {{ x: number, y: number, tone: number }[]}
 */
export function projectCloud(cloud, { width, height, scale = 0.74, offsetY = 0 }) {
  const side = Math.min(width, height) * scale;
  const left = (width - side) / 2;
  const top = (height - side) / 2 + offsetY * height;

  const out = new Array(cloud.tone.length);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = {
      x: left + cloud.xy[i * 2] * side,
      y: top + cloud.xy[i * 2 + 1] * side,
      tone: cloud.tone[i],
    };
  }
  return out;
}

/** Esvazia a cache de nuvens. */
export function clearImageCache() {
  cache.clear();
}
