/**
 * @file nav.js
 * Navegação em DOM: os botões de fio, o painel do poeta e o espelho acessível.
 *
 * Este módulo não sabe que existem partículas. Constrói botões, trata do foco
 * e das marcas de acessibilidade, e anuncia o que o utilizador escolheu no
 * barramento de eventos. Quem quiser reagir que subscreva.
 */

import { EVENTS } from '../core/emitter.js';

/**
 * @typedef {object} NavElements
 * @property {HTMLElement} poetList
 * @property {HTMLElement} poemList
 * @property {HTMLElement} poetName
 * @property {HTMLElement} poetYears
 * @property {HTMLElement} poetNote
 * @property {HTMLElement} rightsNotice
 * @property {HTMLElement} backButton
 * @property {HTMLElement} poemTitle
 * @property {HTMLElement} poemMeta
 * @property {HTMLElement} reader Região aria-live com o texto verdadeiro.
 */

export class Navigation {
  /**
   * @param {object} options
   * @param {NavElements} options.elements
   * @param {import('../data/library.js').Poet[]} options.poets
   * @param {import('../core/emitter.js').Emitter} options.bus
   */
  constructor({ elements, poets, bus }) {
    this.el = elements;
    this.poets = poets;
    this.bus = bus;

    /** @type {Map<string, HTMLButtonElement>} */
    this.poetButtons = new Map();
    /** @type {Map<string, HTMLButtonElement>} */
    this.poemButtons = new Map();

    /** @type {import('../data/library.js').Poet | null} */
    this.currentPoet = null;

  }

  /**
   * Constrói a lista de poetas e liga o botão de recuar.
   *
   * Os atalhos de teclado NÃO são tratados aqui: estão todos em main.js,
   * registados com o mesmo AbortController do resto. Dois módulos a escutar
   * a tecla Escape fariam o site recuar dois passos de cada vez.
   *
   * @param {AddEventListenerOptions} [options] Para partilhar o sinal de
   *   cancelamento da aplicação.
   */
  mount(options) {
    this.renderPoets();
    this.el.backButton.addEventListener('click', () => this.bus.emit(EVENTS.BACK), options);
  }

  /**
   * Cria um botão de fio.
   * @private
   * @param {string} label
   * @param {string} variant Classe modificadora, ex.: 'wire--quiet'.
   * @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  createButton(label, variant, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = variant ? `wire ${variant}` : 'wire';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  /** @private */
  renderPoets() {
    const fragment = document.createDocumentFragment();

    for (const poet of this.poets) {
      const item = document.createElement('li');
      const button = this.createButton(poet.shortName, '', () => {
        this.bus.emit(EVENTS.POET_SELECTED, { poetId: poet.id });
      });
      button.setAttribute('aria-pressed', 'false');
      this.poetButtons.set(poet.id, button);
      item.append(button);
      fragment.append(item);
    }

    // Um só append: cada inserção isolada obrigaria a um recálculo de layout.
    this.el.poetList.replaceChildren(fragment);
  }

  /**
   * Preenche o painel de um poeta e constrói a lista dos seus poemas.
   * @param {import('../data/library.js').Poet} poet
   */
  showPoet(poet) {
    this.currentPoet = poet;

    for (const [id, button] of this.poetButtons) {
      button.setAttribute('aria-pressed', id === poet.id ? 'true' : 'false');
    }

    this.el.poetName.textContent = poet.name;
    this.el.poetYears.textContent = poet.years;
    this.el.poetNote.textContent = poet.note;

    const fragment = document.createDocumentFragment();
    this.poemButtons.clear();

    for (const poem of poet.poems) {
      const item = document.createElement('li');
      const button = this.createButton(poem.title, 'wire--quiet', () => {
        this.bus.emit(EVENTS.POEM_SELECTED, { poetId: poet.id, poemId: poem.id });
      });
      button.setAttribute('aria-pressed', 'false');
      this.poemButtons.set(poem.id, button);
      item.append(button);
      fragment.append(item);
    }

    this.el.poemList.replaceChildren(fragment);

    // Autores cuja obra ainda está protegida não têm poemas para mostrar. Em
    // vez de uma lista vazia e muda, diz-se porquê.
    const hasPoems = poet.poems.length > 0;
    this.el.rightsNotice.hidden = hasPoems;
    this.el.rightsNotice.textContent = hasPoems ? '' : (poet.rightsNote || '');

  }

  /**
   * Marca o poema em curso e escreve a assinatura do rodapé.
   * @param {import('../data/library.js').Poem} poem
   * @param {import('../data/library.js').Poet} poet
   */
  showPoem(poem, poet) {
    for (const [id, button] of this.poemButtons) {
      button.setAttribute('aria-pressed', id === poem.id ? 'true' : 'false');
    }

    this.el.poemTitle.textContent = poem.title;
    this.el.poemMeta.textContent = [poet.name, poem.year].filter(Boolean).join(' · ');
  }

  /** Limpa a marca de poema e a assinatura. */
  clearPoem() {
    for (const button of this.poemButtons.values()) {
      button.setAttribute('aria-pressed', 'false');
    }
    this.el.poemTitle.textContent = '';
    this.el.poemMeta.textContent = '';
  }

  /** Desmarca o poeta. */
  clearPoet() {
    this.currentPoet = null;
    for (const button of this.poetButtons.values()) {
      button.setAttribute('aria-pressed', 'false');
    }
    this.clearPoem();
  }

  /**
   * Escreve na região aria-live.
   *
   * Poucos anúncios e espaçados: uma região aria-live atualizada a cada
   * fotograma, ou com o poema inteiro de cada vez, põe o leitor de ecrã a
   * falar sem parar e torna o site inutilizável. O que se anuncia aqui é o
   * que está a acontecer; o que há para LER está na antologia, em texto
   * verdadeiro, no fim do documento.
   *
   * @param {string} message
   */
  announce(message) {
    this.el.reader.textContent = message;
  }

  /**
   * Põe o foco no primeiro botão de um painel que acabou de aparecer.
   * Sem isto, quem navega por teclado fica com o foco num botão que já não
   * está no ecrã.
   * @param {'poets' | 'poems'} which
   */
  focusFirst(which) {
    const list = which === 'poets' ? this.el.poetList : this.el.poemList;
    const first = list.querySelector('button');
    if (first instanceof HTMLElement) first.focus();
  }
}
