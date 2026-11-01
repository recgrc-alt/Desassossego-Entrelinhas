/**
 * @file loop.js
 * Relógio da animação.
 *
 * Um único requestAnimationFrame para todo o site. Ter dois loops em paralelo
 * — um para as partículas, outro para a atmosfera — custaria o dobro das
 * acordadas ao browser e tiraria qualquer hipótese de os sincronizar.
 */

import { clamp } from './math.js';

/**
 * Teto do passo de tempo, em segundos.
 *
 * Há dois momentos em que o dt vem absurdo. O primeiro fotograma traz o tempo
 * decorrido desde a origem do documento — o carregamento da página inteira,
 * centenas de milissegundos ou segundos. E ao voltar de um separador que
 * esteve minutos escondido, o dt pode valer dezenas de segundos. Em qualquer
 * dos casos, entregue à física sem limite, projeta tudo para fora do ecrã.
 *
 * O primeiro fotograma é descartado (ver lastTime); os restantes são
 * limitados a 1/30 de segundo, de modo que, no pior caso, a cena apanha o
 * atraso ao longo de alguns fotogramas em vez de explodir num só.
 */
const MAX_STEP = 1 / 30;

/**
 * Piso do passo, em segundos. Dois callbacks de requestAnimationFrame no
 * mesmo milissegundo — acontece no Safari — dariam dt zero, que não é
 * perigoso mas não progride e envenena a medição de velocidade do cursor com
 * divisões por zero.
 */
const MIN_STEP = 1 / 240;

/**
 * @callback TickHandler
 * @param {number} dt Segundos desde o fotograma anterior, já limitado.
 * @param {number} elapsed Segundos desde o arranque do loop.
 */

export class Loop {
  constructor() {
    /** @type {TickHandler[]} */
    this.handlers = [];
    this.running = false;
    this.frameId = 0;
    this.lastTime = 0;
    this.elapsed = 0;

    /** Média móvel do dt, para medir a cadência real sem ruído. */
    this.smoothedDelta = 1 / 60;

    /** Média móvel da variação do dt. Distingue uma cadência baixa mas
     *  estável (ecrã de 30 Hz, poupança de energia) de uma máquina a
     *  sufocar. */
    this.jitter = 0;

    this.onFrame = this.onFrame.bind(this);
    this.onVisibilityChange = this.onVisibilityChange.bind(this);
    this.onPageShow = this.onPageShow.bind(this);
  }

  /**
   * Regista uma função a chamar em cada fotograma.
   * @param {TickHandler} handler
   * @returns {() => void} Remove o registo.
   */
  add(handler) {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index !== -1) this.handlers.splice(index, 1);
    };
  }

  start() {
    if (this.running) return;
    this.running = true;

    // lastTime a zero sinaliza "ainda não há fotograma anterior". O primeiro
    // tick usa-o para entregar um dt nominal em vez de um dt absurdo medido
    // contra a origem do relógio da página.
    this.lastTime = 0;

    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pageshow', this.onPageShow);
    this.frameId = window.requestAnimationFrame(this.onFrame);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    window.cancelAnimationFrame(this.frameId);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pageshow', this.onPageShow);
  }

  /**
   * Regresso pela cache de navegação do Safari: a página volta viva, com o
   * JavaScript no estado em que ficou, mas o relógio do requestAnimationFrame
   * andou entretanto. Sem repor lastTime, o primeiro passo depois de voltar
   * traz o tempo todo em que a página esteve guardada.
   * @private
   * @param {PageTransitionEvent} event
   */
  onPageShow(event) {
    if (event.persisted) this.lastTime = 0;
  }

  /**
   * Em segundo plano o browser já estrangula o requestAnimationFrame, mas não
   * o suspende em todos os casos. Parar explicitamente poupa bateria em
   * telemóvel e garante que ao voltar há um dt limpo.
   * @private
   */
  onVisibilityChange() {
    if (document.hidden) {
      window.cancelAnimationFrame(this.frameId);
      return;
    }
    if (!this.running) return;
    this.lastTime = 0;
    this.frameId = window.requestAnimationFrame(this.onFrame);
  }

  /**
   * @private
   * @param {number} time Carimbo de alta resolução entregue pelo browser.
   */
  onFrame(time) {
    if (!this.running) return;
    this.frameId = window.requestAnimationFrame(this.onFrame);

    // O primeiro fotograma depois de arrancar (ou de voltar de um separador
    // escondido) serve só para gravar o relógio. Não há passo nenhum a dar:
    // o intervalo que ele mediria é o tempo de carregamento da página, não o
    // tempo de uma animação.
    if (this.lastTime === 0) {
      this.lastTime = time;
      return;
    }

    const raw = (time - this.lastTime) / 1000;
    this.lastTime = time;

    const dt = clamp(raw, MIN_STEP, MAX_STEP);
    this.elapsed += dt;

    // Média móvel exponencial do intervalo observado, e também da sua
    // variação. O governador de qualidade precisa das duas: um telemóvel em
    // poupança de energia corre a 30 Hz muito certos (variação baixa) e não
    // deve ser confundido com uma máquina a sufocar, que tem o mesmo
    // intervalo médio mas aos solavancos.
    const previous = this.smoothedDelta;
    this.smoothedDelta += (dt - previous) * 0.08;
    this.jitter += (Math.abs(dt - previous) - this.jitter) * 0.08;

    for (let i = 0; i < this.handlers.length; i += 1) {
      this.handlers[i](dt, this.elapsed);
    }
  }

  /**
   * Fotogramas por segundo observados, suavizados.
   * @returns {number}
   */
  get fps() {
    return this.smoothedDelta > 0 ? 1 / this.smoothedDelta : 0;
  }
}
