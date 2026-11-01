/**
 * @file library.js
 * Lê a antologia a partir do próprio documento.
 *
 * Os poemas estão escritos no index.html, e é de lá que o motor os tira. Não
 * há um segundo ficheiro de dados, não há um JSON a ir buscar, não há nada
 * que possa divergir do que está na página: o que se vê no canvas e o que um
 * leitor de ecrã lê são literalmente o mesmo texto.
 *
 * Tem outra vantagem prática: um `fetch` de ficheiro local falharia quando a
 * página fosse aberta diretamente do disco, e um módulo de dados em
 * JavaScript duplicaria o conteúdo. Nenhum dos dois problemas existe aqui.
 *
 * O contrato com o HTML é pequeno e está todo neste ficheiro:
 *
 *   article[data-poet]      — um autor; data-years, data-image, data-short
 *     h3.anthology__name    — o nome
 *     p.anthology__note     — a nota biográfica
 *     p[data-rights]        — explicação, quando não há poemas
 *     section[data-poem]    — um poema; data-year
 *       h4...poem-title     — o título
 *       pre[data-verse]     — os versos, tal e qual
 */

/**
 * @typedef {object} Poem
 * @property {string} id
 * @property {string} title
 * @property {string} year
 * @property {string} text Versos separados por \n, estrofes por \n\n.
 */

/**
 * @typedef {object} Poet
 * @property {string} id
 * @property {string} name Nome por extenso, para o painel do autor.
 * @property {string} shortName Forma abreviada a dois nomes, para o botão.
 *   Os botões dos poetas estão todos numa linha, e "Sophia de Mello Breyner
 *   Andresen" ao lado de "Fernando Pessoa" tirava-lhe o ritmo: um botão com
 *   o triplo da largura dos outros lê-se como erro de composição, não como
 *   um nome mais longo.
 * @property {string} years
 * @property {string} note
 * @property {string} image
 * @property {string} rightsNote Vazio quando há poemas.
 * @property {Poem[]} poems
 */

/**
 * Texto de um descendente, ou vazio se não existir.
 * @param {Element} root
 * @param {string} selector
 * @returns {string}
 */
function textOf(root, selector) {
  const node = root.querySelector(selector);
  return node ? (node.textContent || '').trim() : '';
}

/**
 * Lê a antologia do documento.
 *
 * @param {ParentNode} [root]
 * @returns {Poet[]}
 */
export function readLibrary(root = document) {
  const articles = root.querySelectorAll('article[data-poet]');
  /** @type {Poet[]} */
  const poets = [];

  for (const article of articles) {
    /** @type {Poem[]} */
    const poems = [];

    for (const section of article.querySelectorAll('section[data-poem]')) {
      const verse = section.querySelector('pre[data-verse]');
      if (!verse) continue;

      poems.push({
        id: section.getAttribute('data-poem') || '',
        title: textOf(section, '.anthology__poem-title'),
        year: section.getAttribute('data-year') || '',
        // textContent e não innerText: o primeiro devolve o conteúdo tal como
        // está no documento, e o segundo passa-o pelo motor de layout, que
        // normaliza espaços e quebras. Num poema, as quebras são o conteúdo.
        text: (verse.textContent || '').replace(/\r\n/g, '\n').trim(),
      });
    }

    poets.push({
      id: article.getAttribute('data-poet') || '',
      name: textOf(article, '.anthology__name'),
      shortName: article.getAttribute('data-short') || textOf(article, '.anthology__name'),
      years: article.getAttribute('data-years') || '',
      note: textOf(article, '.anthology__note'),
      image: article.getAttribute('data-image') || '',
      rightsNote: textOf(article, '[data-rights]'),
      poems,
    });
  }

  return poets;
}

/**
 * Índice por identificador.
 * @param {Poet[]} poets
 * @returns {Map<string, Poet>}
 */
export function indexById(poets) {
  return new Map(poets.map((poet) => [poet.id, poet]));
}

/**
 * Encontra um poema dentro de um autor.
 * @param {Map<string, Poet>} index
 * @param {string} poetId
 * @param {string} poemId
 * @returns {{ poet: Poet, poem: Poem } | null}
 */
export function findPoem(index, poetId, poemId) {
  const poet = index.get(poetId);
  if (!poet) return null;
  const poem = poet.poems.find((candidate) => candidate.id === poemId);
  return poem ? { poet, poem } : null;
}

/**
 * O texto de que se tiram as letras de um autor.
 *
 * Um autor cuja obra ainda está protegida não tem versos para dar. Em vez do
 * nome sozinho — que daria um rosto cheio de maiúsculas e de algarismos —
 * serve a frase que explica a ausência. É a leitura certa: o retrato fica
 * feito do texto que diz porque é que os poemas não estão lá.
 *
 * @param {Poet} poet
 * @returns {string}
 */
function sourceTextFor(poet) {
  return poet.poems.length > 0
    ? poet.poems.map((poem) => poem.text).join(' ')
    : `${poet.name} ${poet.note} ${poet.rightsNote}`;
}

/**
 * Traduz um texto no conjunto de letras com que ele pode ser escrito: os
 * índices do alfabeto do atlas, COM repetições.
 *
 * É daqui que saem as letras das partículas — as que compõem um rosto e as
 * que flutuam no campo. O retrato de cada poeta é desenhado com os caracteres
 * que ele próprio usou, na proporção em que os usou: quem escreveu muitas
 * vezes "mar" tem o rosto cheio de emes.
 *
 * GUARDAR AS REPETIÇÕES É O PONTO
 * Um conjunto de caracteres DISTINTOS daria a todos os poetas a mesma
 * distribuição — o alfabeto do atlas — e o detalhe perder-se-ia. É também o
 * que separa um campo de letras de um campo de ruído, e isto mede-se: num
 * sorteio uniforme sobre o alfabeto do atlas, cada mil letras no ecrã trazem
 * 358 maiúsculas, 200 sinais de pontuação e 83 algarismos, porque o alfabeto
 * tem tantas maiúsculas como minúsculas e dez dígitos que a poesia não usa.
 * Sorteadas dos versos, as mesmas mil letras trazem 876 minúsculas, 44
 * maiúsculas, 77 sinais e 4 algarismos. A primeira distribuição não existe em
 * nenhuma língua; a segunda é uma página de poesia desfeita em letras.
 *
 * Num array tipado, e em duas passagens: a antologia são seis mil letras e os
 * conjuntos ficam em memória toda a sessão. A primeira passagem só conta.
 *
 * @param {string} text
 * @param {import('../particles/atlas.js').GlyphAtlas} atlas
 * @returns {Uint16Array}
 */
function glyphPool(text, atlas) {
  let size = 0;
  for (const char of text) {
    if (atlas.glyphFor(char) >= 0) size += 1;
  }

  const pool = new Uint16Array(size);
  let n = 0;
  for (const char of text) {
    const index = atlas.glyphFor(char);
    if (index < 0) continue;
    pool[n] = index;
    n += 1;
  }

  return pool;
}

/**
 * As letras de um autor.
 * @param {Poet} poet
 * @param {import('../particles/atlas.js').GlyphAtlas} atlas
 * @returns {Uint16Array}
 */
export function glyphPoolFor(poet, atlas) {
  return glyphPool(sourceTextFor(poet), atlas);
}

/**
 * As letras de toda a antologia, para o campo que ainda não escolheu autor.
 *
 * É com estas que o site abre: um campo feito da soma dos cinco, que depois
 * se estreita a um só quando alguém escolhe.
 *
 * @param {Poet[]} poets
 * @param {import('../particles/atlas.js').GlyphAtlas} atlas
 * @returns {Uint16Array}
 */
export function glyphPoolForLibrary(poets, atlas) {
  return glyphPool(poets.map(sourceTextFor).join(' '), atlas);
}

/**
 * Todos os caracteres distintos usados em todo o site — nomes, notas, versos
 * e o alfabeto do atlas.
 *
 * Serve para pedir a fonte ao browser passando o texto: a Google Fonts serve
 * o EB Garamond partido por intervalos de Unicode, e sem o texto o
 * subconjunto onde vivem o ã, o ç e o õ nunca chega a ser pedido. Ver
 * waitForFonts em scripts/core/env.js.
 *
 * @param {Poet[]} poets
 * @param {string} [extra]
 * @returns {string}
 */
export function alphabetInUse(poets, extra = '') {
  const seen = new Set(extra);

  for (const poet of poets) {
    for (const char of poet.name) seen.add(char);
    for (const char of poet.years) seen.add(char);
    for (const char of poet.note) seen.add(char);
    for (const poem of poet.poems) {
      for (const char of poem.title) seen.add(char);
      for (const char of poem.text) seen.add(char);
    }
  }

  return Array.from(seen).join('');
}
