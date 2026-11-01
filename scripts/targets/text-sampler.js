/**
 * @file text-sampler.js
 * Texto transformado em destinos para as partículas.
 *
 * Dá às partículas um lugar em cada letra de um texto: composePoem() para um
 * poema inteiro, numa ou em duas colunas, e composeWord() para uma palavra
 * solta no meio do campo. Uma partícula por glifo, cada uma a adotar o
 * carácter certo quando lá chega.
 *
 * (Houve aqui uma terceira função, sampleElementInk, que pegava num elemento
 * de texto do ecrã e devolvia uma nuvem com a forma da sua tinta — era com ela
 * que a saudação de entrada se desfazia em grão. A entrada passou a ser um
 * desvanecimento simples, e a função saiu com ela.)
 */

/**
 * Duração total da escrita de um poema, em segundos.
 *
 * Parametriza-se a DURAÇÃO e deduz-se a cadência, e não o contrário. Assim um
 * soneto de catorze versos e um poema de quarenta demoram o mesmo tempo e têm
 * o mesmo carácter; com "milissegundos por carácter" fixos, o poema longo
 * passaria a ser uma espera.
 *
 * O número que governa a sensação não é o atraso por glifo — é quantos glifos
 * estão em voo ao mesmo tempo, que é o tempo de assentamento a dividir pela
 * cadência. Com 7.5 s para um soneto de 400 letras são cerca de 40 em voo:
 * uma onda densa, que se lê como escrita contínua e tinta ainda fresca. Para
 * uma máquina de escrever, um glifo de cada vez, seriam precisos 60 ms por
 * carácter — e quarenta segundos de tédio.
 */
const WRITE_SPAN = 7.5;

/** Fração da duração gasta nas pausas de fim de verso. São elas que impedem
 *  que a onda seja uma diagonal contínua: são a respiração do poema. */
const LINE_PAUSE_SHARE = 0.3;

/**
 * Mede o verso mais largo e o poema mais alto de um conjunto de textos.
 *
 * @param {string[]} texts
 * @param {string} fontFamily
 * @returns {{ widthRatio: number, maxLines: number }} widthRatio é a largura
 *   do verso mais longo a dividir pelo corpo de letra usado na medição.
 */
function measureCorpus(texts, fontFamily) {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return { widthRatio: 24, maxLines: 20 };

  const probe = 100;
  ctx.font = `${probe}px ${fontFamily}`;

  let widest = 0;
  let maxLines = 0;

  for (const text of texts) {
    const lines = text.split('\n');
    if (lines.length > maxLines) maxLines = lines.length;
    for (const line of lines) {
      const width = ctx.measureText(line).width;
      if (width > widest) widest = width;
    }
  }

  return { widthRatio: widest / probe, maxLines };
}

/**
 * Decide em quantas colunas um poema é composto e com que corpo de letra.
 *
 * Um poema de quarenta versos não cabe numa coluna sem encolher a letra para
 * oito píxeis, que é ilegível. A resposta tipográfica certa não é encolher —
 * é abrir uma segunda coluna, como qualquer edição faria. O corpo é depois o
 * maior que satisfaça as duas restrições: o verso mais longo tem de caber na
 * largura de uma coluna, e a coluna mais alta tem de caber na altura da
 * moldura.
 *
 * MAS O CRITÉRIO NÃO É "O CORPO MAIOR". Foi, e estava errado. Um soneto tem
 * dezassete linhas com as brancas, cabe numa coluna a 19 píxeis, e cabia em
 * duas a 21 — por isso a regra do corpo maior partia todos os sonetos ao
 * meio. Um soneto é 4-4-3-3: cortado a meio deixa de ser um soneto, e dois
 * píxeis de corpo não pagam isso.
 *
 * O critério certo é o MÍNIMO de colunas que dê um corpo confortável. Só se
 * nenhum número de colunas chegar ao conforto é que se escolhe o que der o
 * corpo maior — que é o caso dos poemas muito longos, onde a segunda coluna
 * é mesmo a única saída.
 *
 * Em ecrãs estreitos só há uma coluna, e aí o limite mínimo de corpo manda:
 * um poema muito longo fica composto no mínimo legível, e o fim pode sair da
 * moldura. É um compromisso assumido — o poema continua inteiro e legível na
 * antologia em texto.
 *
 * @param {object} options
 * @param {string} options.text
 * @param {string} options.fontFamily
 * @param {{ width: number, height: number }} options.frame Em píxeis de CSS.
 * @param {{ min: number, max: number, lineHeight: number, tracking: number, gutter: number }} options.reading
 * @param {number} [options.maxColumns]
 * @returns {{ size: number, columns: number, linesPerColumn: number }}
 */
export function planPoemLayout({ text, fontFamily, frame, reading, maxColumns = 2 }) {
  const lines = text.split('\n');
  const { widthRatio } = measureCorpus([text], fontFamily);

  // O espacejamento é dado em em, logo entra no rácio de largura: cada
  // carácter acrescenta `tracking` vezes o corpo. Estima-se o número de
  // caracteres do verso mais longo a partir do próprio rácio, contando um
  // carácter médio a cerca de 0.45 em nesta serifa.
  const charsPerLine = widthRatio / 0.45;
  const lineRatio = widthRatio + reading.tracking * charsPerLine;

  // Em ecrãs estreitos uma segunda coluna não ajuda: espreme as duas a ponto
  // de obrigar ao corpo mínimo. O limiar é em múltiplos do corpo mínimo, e
  // não em píxeis, para acompanhar quem tenha o tipo de letra do browser
  // aumentado.
  const allowed = frame.width >= 30 * reading.min ? maxColumns : 1;

  /** A primeira repartição que atinge o conforto. */
  let confortavel = null;
  /** E, se nenhuma atingir, a que der o corpo maior. */
  let maior = { size: 0, columns: 1, linesPerColumn: lines.length };

  for (let columns = 1; columns <= allowed; columns += 1) {
    const linesPerColumn = Math.ceil(lines.length / columns);

    // Largura disponível por coluna, descontadas as calhas. A calha é dada em
    // múltiplos do corpo, que é a incógnita — resolve-se a desigualdade
    //   columns · ratio · s + (columns − 1) · gutter · s ≤ largura
    // para s.
    const denominator = columns * lineRatio + (columns - 1) * reading.gutter;
    const byWidth = frame.width / Math.max(denominator, 0.001);
    const byHeight = frame.height / Math.max(linesPerColumn * reading.lineHeight, 0.001);

    const size = Math.min(reading.max, byWidth, byHeight);
    const reparticao = { size, columns, linesPerColumn };

    if (size > maior.size) maior = reparticao;
    if (confortavel === null && size >= reading.comfort) confortavel = reparticao;
  }

  const escolhida = confortavel ?? maior;
  return { ...escolhida, size: Math.max(reading.min, escolhida.size) };
}

/**
 * Reparte os versos por colunas, preferindo cortar entre estrofes.
 *
 * Cortar um poema a meio de uma estrofe é um erro de composição que se vê de
 * longe. Procura-se por isso a linha em branco mais próxima do ponto de corte
 * ideal, e só se corta à força quando não houver nenhuma por perto.
 *
 * @param {string[]} lines
 * @param {number} columns
 * @returns {string[][]}
 */
function splitIntoColumns(lines, columns) {
  if (columns <= 1) return [lines];

  const out = [];
  let start = 0;

  for (let c = 0; c < columns; c += 1) {
    const remainingColumns = columns - c;
    if (remainingColumns === 1) {
      out.push(lines.slice(start));
      break;
    }

    const ideal = start + Math.ceil((lines.length - start) / remainingColumns);
    let cut = ideal;
    let bestDistance = Infinity;

    // Janela de procura: um quinto da coluna para cada lado.
    const window = Math.max(2, Math.round((ideal - start) * 0.2));
    for (let k = ideal - window; k <= ideal + window; k += 1) {
      if (k <= start || k >= lines.length) continue;
      if (lines[k - 1].trim() !== '') continue;
      const distance = Math.abs(k - ideal);
      if (distance < bestDistance) {
        bestDistance = distance;
        cut = k;
      }
    }

    out.push(lines.slice(start, cut));
    start = cut;
  }

  return out;
}

/**
 * Compõe um poema como lista de destinos.
 *
 * O bloco é centrado na moldura; dentro de cada coluna os versos ficam
 * alinhados à esquerda, que é como se compõe poesia — centrar verso a verso
 * destrói a coluna que o olho usa para descer o poema.
 *
 * O atraso de cada glifo cresce na ordem de leitura. É esta única propriedade
 * que produz a sensação de o poema estar a ser escrito: as partículas partem
 * todas do sítio onde estavam, mas cada uma espera a sua vez antes de ser
 * puxada para o verso.
 *
 * @param {string} text Poema, versos separados por \n, estrofes por \n\n.
 * @param {object} options
 * @param {import('../particles/atlas.js').GlyphAtlas} options.atlas
 * @param {number} options.tier Plano do atlas a usar (o de leitura).
 * @param {{ x: number, y: number, width: number, height: number }} options.frame
 * @param {number} options.columns
 * @param {number} options.lineHeight Entrelinha, em múltiplos do corpo.
 * @param {number} options.tracking Espacejamento, em em.
 * @param {number} options.gutter Calha entre colunas, em múltiplos do corpo.
 * @param {number} [options.alpha]
 * @param {number} [options.span] Duração total da escrita, em segundos.
 * @returns {import('../particles/system.js').TargetPoint[]}
 */
export function composePoem(text, {
  atlas,
  tier,
  frame,
  columns,
  lineHeight,
  tracking,
  gutter,
  alpha = 1,
  span = WRITE_SPAN,
}) {
  // O corpo de letra vem do atlas, não de um parâmetro. As partículas são
  // desenhadas copiando células já rasterizadas, por isso o tamanho aparente
  // de um glifo é o tamanho com que foi rasterizado — medir o verso com outro
  // corpo faria o espacejamento deixar de corresponder ao desenho.
  const size = atlas.sizes[tier];
  const trackingPx = tracking * size;
  const lineStep = lineHeight * size;
  const spaceWidth = atlas.spaceAdvance[tier];

  const blocks = splitIntoColumns(text.split('\n'), columns);

  /** @type {{ chars: {glyph: number, offset: number}[] }[][]} */
  const measured = [];
  const columnWidths = [];
  let tallest = 0;
  let totalGlyphs = 0;
  let totalLines = 0;

  for (const block of blocks) {
    const rows = [];
    let widest = 0;

    for (const line of block) {
      const chars = [];
      let cursor = 0;

      for (const char of line) {
        if (char === ' ' || char === ' ') {
          cursor += spaceWidth + trackingPx;
          continue;
        }

        const glyph = atlas.glyphFor(char);
        if (glyph < 0) {
          // Carácter fora do alfabeto: ocupa lugar para não desalinhar o
          // verso, mas não ganha partícula.
          cursor += spaceWidth + trackingPx;
          continue;
        }

        const advance = atlas.advance[atlas.cell(tier, glyph)];
        chars.push({ glyph, offset: cursor + advance / 2 });
        cursor += advance + trackingPx;
      }

      const width = Math.max(0, cursor - trackingPx);
      if (width > widest) widest = width;
      rows.push({ chars });
      totalGlyphs += chars.length;
    }

    if (rows.length > tallest) tallest = rows.length;
    totalLines += rows.length;
    columnWidths.push(widest);
    measured.push(rows);
  }

  // --- Calendário ---------------------------------------------------------
  // A duração total reparte-se entre o avanço carácter a carácter e as pausas
  // de fim de verso. Um poema sem glifos nenhuns não divide por zero.
  const pauseBudget = span * LINE_PAUSE_SHARE;
  const charBudget = span - pauseBudget;
  const charDelay = totalGlyphs > 0 ? charBudget / totalGlyphs : 0;
  const lineDelay = totalLines > 1 ? pauseBudget / (totalLines - 1) : 0;

  // --- Posição do bloco ---------------------------------------------------
  const gutterPx = gutter * size;
  const blockWidth = columnWidths.reduce((a, b) => a + b, 0) + gutterPx * (columns - 1);
  const blockHeight = tallest * lineStep;

  const left = frame.x + (frame.width - blockWidth) / 2;
  const top = frame.y + (frame.height - blockHeight) / 2;

  /** @type {import('../particles/system.js').TargetPoint[]} */
  const targets = [];
  let elapsed = 0;
  let columnLeft = left;

  for (let c = 0; c < measured.length; c += 1) {
    const rows = measured[c];

    for (let lineIndex = 0; lineIndex < rows.length; lineIndex += 1) {
      const baseline = top + lineIndex * lineStep + lineStep / 2;

      for (const { glyph, offset } of rows[lineIndex].chars) {
        targets.push({
          x: columnLeft + offset,
          y: baseline,
          glyph,
          tier,
          alpha,
          delay: elapsed,
        });
        elapsed += charDelay;
      }

      elapsed += lineDelay;
    }

    columnLeft += columnWidths[c] + gutterPx;
  }

  return targets;
}

/**
 * Compõe uma palavra solta algures no ecrã — as palavras que se formam e
 * desfazem no campo da página inicial.
 *
 * @param {string} word
 * @param {object} options
 * @param {import('../particles/atlas.js').GlyphAtlas} options.atlas
 * @param {number} options.tier
 * @param {number} options.centreX
 * @param {number} options.centreY
 * @param {number} [options.tracking] Em em.
 * @param {number} [options.alpha]
 * @returns {import('../particles/system.js').TargetPoint[]}
 */
export function composeWord(word, {
  atlas,
  tier,
  centreX,
  centreY,
  tracking = 0.14,
  alpha = 1,
}) {
  // Tal como num poema, o corpo é o do plano escolhido: é a escolha do plano
  // que dá à palavra o seu tamanho e, com ele, a sua profundidade.
  const size = atlas.sizes[tier];
  const trackingPx = tracking * size;

  const glyphs = [];
  let cursor = 0;

  for (const char of word) {
    const glyph = atlas.glyphFor(char);
    if (glyph < 0) continue;
    const advance = atlas.advance[atlas.cell(tier, glyph)];
    glyphs.push({ glyph, offset: cursor + advance / 2 });
    cursor += advance + trackingPx;
  }

  const width = Math.max(0, cursor - trackingPx);
  const left = centreX - width / 2;

  return glyphs.map(({ glyph, offset }, index) => ({
    x: left + offset,
    y: centreY,
    glyph,
    tier,
    alpha,
    delay: index * 0.035,
  }));
}
