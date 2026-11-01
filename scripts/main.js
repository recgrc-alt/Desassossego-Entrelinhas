/**
 * @file main.js
 * Arranque.
 *
 * Monta as peças pela ordem certa, liga os eventos do mundo exterior
 * (ponteiro, redimensionamento, densidade de ecrã, preferências) e entrega o
 * comando ao director.
 *
 * A ordem do arranque não é arbitrária:
 *
 *   1. Ler a antologia do DOM. É dela que sai o alfabeto a pedir à fonte.
 *   2. Esperar pela fonte, PASSANDO o texto. Sem isto o atlas é rasterizado
 *      com a serifa de recurso e as métricas ficam erradas para o resto da
 *      sessão, sem um único erro na consola.
 *   3. Construir o atlas, que depende da fonte.
 *   4. Construir o enxame, que depende do atlas.
 *
 * Todos os eventos são registados com o sinal de um único AbortController,
 * para que destroy() os largue a todos de uma vez. Um ouvinte esquecido num
 * canvas que já não existe é uma fuga que não aparece na heap de JavaScript —
 * só na memória do processo.
 */

import { bus, EVENTS } from './core/emitter.js';
import { readEnvironment, waitForFonts, watchPixelRatio, watchReducedMotion } from './core/env.js';
import { Loop } from './core/loop.js';
import { ALPHABET, GlyphAtlas } from './particles/atlas.js';
import { Renderer } from './particles/renderer.js';
import { ParticleSystem } from './particles/system.js';
import { alphabetInUse, indexById, readLibrary } from './data/library.js';
import { clearImageCache } from './targets/image-sampler.js';
import { Director } from './states/director.js';
import { Atmosphere } from './ui/atmosphere.js';
import { Navigation } from './ui/nav.js';

/** Atraso do redimensionamento, em milissegundos. */
const RESIZE_DEBOUNCE = 150;

/**
 * Variação de altura, em píxeis, abaixo da qual um redimensionamento é
 * ignorado em ecrãs tácteis.
 *
 * No iOS, a barra de endereço encolhe e cresce com o scroll e dispara um
 * resize a cada passo. Sem este travão são dezenas de realocações do buffer
 * do canvas por segundo e um congelamento de um ou dois segundos. A barra
 * ocupa entre 44 e 110 píxeis conforme o modelo; 150 cobre todos.
 */
const MOBILE_HEIGHT_GUARD = 150;

/** Após uma rotação, o iOS reporta as dimensões antigas durante um momento. */
const ORIENTATION_SETTLE = 350;

/**
 * Pede os elementos pelo identificador e falha ruidosamente se faltar algum.
 * Um `null` que atravesse meia dúzia de módulos antes de rebentar é muito
 * mais difícil de diagnosticar do que uma falha aqui.
 *
 * @param {Record<string, string>} map
 * @returns {Record<string, HTMLElement>}
 */
function collect(map) {
  /** @type {Record<string, HTMLElement>} */
  const out = {};
  for (const [key, id] of Object.entries(map)) {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Falta o elemento #${id} no documento.`);
    out[key] = node;
  }
  return out;
}

class App {
  constructor() {
    this.controller = new AbortController();
    this.loop = new Loop();
    this.atmosphere = new Atmosphere();

    this.resizeTimer = 0;
    this.lastWidth = window.innerWidth;
    this.lastHeight = window.innerHeight;

    /** @type {(() => void)[]} */
    this.disposers = [];
  }

  /** @returns {AddEventListenerOptions} */
  get signalled() {
    return { signal: this.controller.signal };
  }

  async start() {
    this.el = collect({
      canvas: 'palco',
      intro: 'intro',
      greeting: 'saudacao',
      scene: 'cena',
      centre: 'centro',
      poetList: 'lista-poetas',
      poemList: 'lista-poemas',
      poetName: 'poeta-nome',
      poetYears: 'poeta-anos',
      poetNote: 'poeta-nota',
      rightsNotice: 'aviso-direitos',
      backButton: 'botao-voltar',
      poemTitle: 'poema-titulo',
      poemMeta: 'poema-meta',
      poemFrame: 'moldura-poema',
      reader: 'anuncio',
      motionOffer: 'oferta-movimento',
      motionButton: 'botao-movimento',
    });

    // A cena só deixa de estar escondida quando há motor para a animar.
    this.el.scene.hidden = false;

    this.atmosphere.start();

    // --- 1. A antologia ----------------------------------------------------
    this.poets = readLibrary();
    if (this.poets.length === 0) throw new Error('A antologia está vazia.');
    this.index = indexById(this.poets);

    // --- 2. O ambiente e a fonte -------------------------------------------
    this.env = readEnvironment();

    // Quatro planos de profundidade mais o de leitura. O corpo do plano de
    // leitura é recalculado a cada poema; aqui entra o máximo, que é o que o
    // atlas precisa de saber para reservar as células maiores.
    const sizes = [
      ...this.env.layers.map((layer) => layer.size),
      this.env.reading.max,
      this.env.word.size,
    ];

    const text = alphabetInUse(this.poets, `${ALPHABET}Bem-vindoDesassossegoEntrelinhas…—–«»`);
    const fontReady = await waitForFonts({
      fontFamily: this.env.fontFamily,
      sizes,
      text,
    });

    if (!fontReady) {
      // Não é motivo para desistir: o atlas sai com a serifa de recurso, que
      // é feia mas funciona. Vale a pena ficar registado.
      console.warn('[arranque] O EB Garamond não ficou disponível a tempo; o atlas usa a serifa de recurso.');
    }

    // --- 3. O atlas --------------------------------------------------------
    this.atlas = new GlyphAtlas({
      sizes,
      fontFamily: this.env.fontFamily,
      color: this.env.glyphColor,
      dpr: this.env.dpr,
    }).build();

    // --- 4. O enxame -------------------------------------------------------
    // Os planos de leitura e das palavras juntam-se aos quatro de
    // profundidade: o renderer precisa de uma opacidade por plano do atlas, e
    // o sistema precisa de um ganho de paralaxe por plano.
    this.renderLayers = [
      ...this.env.layers,
      { size: this.env.reading.max, opacity: this.env.reading.opacity, parallax: 1 },
      { size: this.env.word.size, opacity: this.env.word.opacity, parallax: 1.2 },
    ];

    const width = window.innerWidth;
    const height = window.innerHeight;

    this.system = new ParticleSystem({
      atlas: this.atlas,
      layers: this.renderLayers,
      count: this.env.particleBudget,
      width,
      height,
    });

    this.renderer = new Renderer(
      /** @type {HTMLCanvasElement} */ (this.el.canvas),
      this.atlas,
      this.renderLayers,
      this.env.particleBudget,
    );
    this.renderer.resize(width, height, this.env.dpr);

    // --- 5. Navegação e encenação ------------------------------------------
    this.nav = new Navigation({
      elements: {
        poetList: this.el.poetList,
        poemList: this.el.poemList,
        poetName: this.el.poetName,
        poetYears: this.el.poetYears,
        poetNote: this.el.poetNote,
        rightsNotice: this.el.rightsNotice,
        backButton: this.el.backButton,
        poemTitle: this.el.poemTitle,
        poemMeta: this.el.poemMeta,
        reader: this.el.reader,
      },
      poets: this.poets,
      bus,
    });
    this.nav.mount(this.signalled);

    this.director = new Director({
      system: this.system,
      renderer: this.renderer,
      atlas: this.atlas,
      env: this.env,
      nav: this.nav,
      bus,
      poets: this.poets,
      index: this.index,
      elements: {
        greeting: this.el.greeting,
        intro: this.el.intro,
        poemFrame: this.el.poemFrame,
        centre: this.el.centre,
      },
    });

    this.bindWorld();

    // --- 6. Arrancar --------------------------------------------------------
    // O loop recebe o seu trabalho agora, uma vez só, quer venha a correr ou
    // não. Registá-lo mais tarde, num segundo caminho, é como se duplica um
    // loop sem dar por isso — e um loop duplicado faz a animação correr ao
    // dobro da velocidade, defeito que só aparece depois de duas trocas de
    // separador e é difícil de atribuir.
    this.loop.add((dt, time) => this.director.update(dt, time, this.loop));

    if (this.env.reducedMotion) {
      await this.enterStillMode();
      return;
    }

    this.loop.start();

    // A folha de entrada é a página de carregamento: só levanta quando os
    // cinco retratos estiverem analisados. Depois disso, escolher um poeta é
    // instantâneo — a nuvem de pontos já está calculada e em cache.
    this.director.runIntro(this.director.warmPortraits());
  }

  /**
   * Modo parado, para quem pediu menos movimento.
   *
   * Nada de reduzir a animação: milhares de glifos a flutuar continuam a ser
   * um gatilho vestibular ainda que sejam menos. O que se faz é compor um
   * único fotograma com o estado final e oferecer um botão explícito para
   * quem quiser ver o resto.
   *
   * @private
   */
  async enterStillMode() {
    await this.director.composeStill();
    this.el.motionOffer.hidden = false;

    this.el.motionButton.addEventListener('click', () => {
      this.el.motionOffer.hidden = true;
      this.director.setStill(false);
      this.loop.start();
      this.director.enterHome();
    }, this.signalled);
  }

  /**
   * Liga tudo o que vem de fora: ponteiro, teclado, janela, ecrã.
   * @private
   */
  bindWorld() {
    const { signal } = this.controller;

    // --- Ponteiro -----------------------------------------------------------
    // Pointer Events em vez de mouse e touch em separado: um só caminho para
    // rato, dedo e caneta. passive porque nenhum destes chama preventDefault —
    // declará-lo deixa o browser desencadear o scroll sem esperar por nós.
    window.addEventListener('pointermove', (event) => {
      this.system.setPointer(event.clientX, event.clientY, true);
    }, { signal, passive: true });

    window.addEventListener('pointerdown', (event) => {
      this.system.setPointer(event.clientX, event.clientY, true);
    }, { signal, passive: true });

    // Num ecrã táctil não há "sair com o cursor": sem isto o campo de forças
    // fica colado ao último sítio tocado para sempre.
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      window.addEventListener(type, () => {
        this.system.setPointer(this.system.pointer.x, this.system.pointer.y, false);
      }, { signal, passive: true });
    }

    // --- Teclado ------------------------------------------------------------
    // Escape recua um passo. É a expectativa de qualquer pessoa num ecrã que
    // entrou em modo imersivo.
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') bus.emit(EVENTS.BACK);
    }, { signal });

    // --- Janela -------------------------------------------------------------
    window.addEventListener('resize', () => this.scheduleResize(), { signal, passive: true });
    window.addEventListener('orientationchange', () => {
      window.setTimeout(() => this.applyResize(true), ORIENTATION_SETTLE);
    }, { signal, passive: true });

    // --- Densidade do ecrã --------------------------------------------------
    this.disposers.push(watchPixelRatio(() => this.applyResize(true)));

    // --- Preferência de movimento, mudada a meio da sessão -------------------
    // A preferência pode mudar a meio da sessão — alguém liga a definição no
    // sistema com o separador aberto. Parar o ciclo sem mais deixaria o ecrã
    // congelado a meio de uma transição, com meio rosto formado; por isso
    // entra-se no modo parado, que assenta tudo no destino e desenha um
    // último fotograma, e só então o ciclo pára.
    this.disposers.push(watchReducedMotion((reduced) => {
      if (reduced) {
        this.director.setStill(true);
        this.loop.stop();
        this.el.motionOffer.hidden = false;
        return;
      }
      this.el.motionOffer.hidden = true;
      this.director.setStill(false);
      this.loop.start();
    }));

    // persisted distingue sair da página de a guardar na cache de navegação.
    // Sem este teste, recuar com o botão do browser devolvia uma página morta:
    // destroy() é irreversível e a primeira coisa que faz é parar o ciclo,
    // que leva consigo o próprio ouvinte de pageshow encarregado de a acordar.
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) this.destroy();
    }, { signal });
  }

  /**
   * Agenda um redimensionamento.
   * @private
   */
  scheduleResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Em ecrãs tácteis, uma variação só de altura e pequena é a barra de
    // endereço a aparecer ou a esconder-se com o scroll — não uma mudança de
    // tamanho de janela. Reagir a isso realocaria o buffer do canvas dezenas
    // de vezes por segundo.
    if (this.env.coarsePointer
      && width === this.lastWidth
      && Math.abs(height - this.lastHeight) < MOBILE_HEIGHT_GUARD) {
      return;
    }

    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.applyResize(false), RESIZE_DEBOUNCE);
  }

  /**
   * Aplica um redimensionamento.
   * @private
   * @param {boolean} densityChanged Se a densidade do ecrã mudou, o atlas tem
   *   de ser rasterizado outra vez; se foi só o tamanho da janela, não — e
   *   rasterizá-lo a cada passo do arrasto de uma janela no desktop geraria
   *   uma avalanche de lixo.
   */
  applyResize(densityChanged) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.lastWidth = width;
    this.lastHeight = height;

    const next = readEnvironment();
    // O orçamento de partículas NÃO é recalculado: os arrays tipados foram
    // reservados no arranque e mudá-los a meio obrigaria a realocar tudo. A
    // adaptação ao desempenho em curso é feita pelo governador de qualidade,
    // que não precisa de realocar nada.
    this.env = { ...next, particleBudget: this.env.particleBudget };

    if (densityChanged || Math.abs(this.atlas.dpr - next.dpr) > 0.01) {
      this.atlas.dpr = next.dpr;
      this.atlas.build();
    }

    this.system.resize(width, height);
    this.renderer.resize(width, height, next.dpr);
    this.director.env = this.env;
    this.director.recompose();

    bus.emit(EVENTS.VIEWPORT_CHANGED, { width, height });
  }

  /** Larga tudo. */
  destroy() {
    this.loop.stop();
    this.controller.abort();
    this.atmosphere.stop();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.atlas.dispose();
    clearImageCache();
    bus.clear();
  }
}

/**
 * Arranca, e se alguma coisa correr mal entrega a página ao plano B: a
 * antologia em texto corrido, que é o conteúdo verdadeiro e nunca dependeu
 * de nada disto.
 */
async function boot() {
  const app = new App();
  try {
    await app.start();
  } catch (error) {
    console.error('[arranque] O motor não conseguiu arrancar.', error);
    document.documentElement.classList.add('engine-failed');
    try {
      app.destroy();
    } catch {
      // Já estamos no caminho de falha; não há nada a ganhar em insistir.
    }
  }
}

boot();
