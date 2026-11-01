/**
 * @file emitter.js
 * Emissor de eventos mínimo.
 *
 * O sistema de partículas não pode conhecer a navegação, nem a navegação pode
 * chamar o sistema de partículas diretamente — se o fizessem, mudar um botão
 * obrigaria a mexer na física. Toda a conversa entre módulos passa por aqui,
 * em nomes de eventos declarados num sítio só (ver EVENTS, mais abaixo).
 */

/**
 * Nomes de evento usados no projeto. Declarados como constantes para que um
 * erro de escrita rebente na importação e não em silêncio no arranque.
 * @readonly
 */
export const EVENTS = {
  /** O utilizador escolheu um poeta. Carga: { poetId }. */
  POET_SELECTED: 'poet:selected',
  /** O utilizador escolheu um poema. Carga: { poetId, poemId }. */
  POEM_SELECTED: 'poem:selected',
  /** Pedido de regresso ao ecrã anterior. Sem carga. */
  BACK: 'nav:back',
  /** A encenação mudou de etapa. Carga: { stage, previous }. */
  STAGE_CHANGED: 'stage:changed',
  /** A janela mudou de tamanho, já com o atraso aplicado. Carga: { width, height }. */
  VIEWPORT_CHANGED: 'viewport:changed',
};

/**
 * Emissor de eventos simples, síncrono.
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /**
   * Subscreve um evento.
   * @param {string} type
   * @param {Function} handler
   * @returns {() => void} Função que cancela a subscrição. Devolver o
   *   cancelamento em vez de obrigar a guardar a referência do handler é o que
   *   torna possível desmontar um estado sem deixar escutas penduradas.
   */
  on(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }

  /**
   * Cancela uma subscrição.
   * @param {string} type
   * @param {Function} handler
   */
  off(type, handler) {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.listeners.delete(type);
  }

  /**
   * Dispara um evento.
   *
   * Itera sobre uma cópia do conjunto: sem isso, um ouvinte que se cancele a
   * si próprio durante a chamada modificaria o Set a meio da iteração.
   *
   * @param {string} type
   * @param {object} [payload]
   */
  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of Array.from(set)) {
      handler(payload);
    }
  }

  /** Larga tudo. Usado no descarregamento da página. */
  clear() {
    this.listeners.clear();
  }
}

/** Instância partilhada por toda a aplicação. */
export const bus = new Emitter();
