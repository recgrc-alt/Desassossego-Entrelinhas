/**
 * @file physics.js
 * O passo de integração e as constantes que lhe dão carácter.
 *
 * Uma partícula está sempre num de dois regimes:
 *
 *   PRESA (held) — tem um destino e é puxada para lá por uma mola amortecida.
 *                  É assim que se compõe um rosto e se escreve um poema.
 *
 *   LIVRE        — não tem destino nenhum e navega um campo de correntes. É
 *                  assim que as letras voam no campo da página inicial e na
 *                  neblina à volta de um rosto.
 *
 * O campo de forças do cursor soma-se por cima dos dois.
 *
 * ---------------------------------------------------------------------------
 * A MOLA, E PORQUÊ UMA SOLUÇÃO FECHADA
 *
 *     x'' = −ω²(x − destino) − 2ζω x'
 *
 * ω é a frequência angular (quão depressa quer chegar) e ζ a razão de
 * amortecimento (quanto oscila à chegada). Parametriza-se sempre por estes
 * dois, nunca por k e c: mexer em k mudaria ao mesmo tempo a velocidade e o
 * amortecimento efetivo, ζ = c/(2√k), e o que parecia afinado desafinava à
 * mudança de estado. A régua, para amortecimento crítico, é t(2%) ≈ 5.83/ω.
 *
 * A tentação é integrar com Euler semi-implícito, que aqui seria estável com
 * folga. Funciona — mas o erro depende de dt, e dt não é constante: 16.7 ms a
 * 60 Hz, 8.3 ms num ProMotion, 33 ms num iPhone em poupança de energia. O
 * movimento ficava com carácter diferente de máquina para máquina.
 *
 * A alternativa é avaliar a solução exata: para um destino constante durante o
 * passo, o estado evolui pela matriz de transição e^(A·dt), que tem forma
 * fechada. Os quatro coeficientes dependem só de ω, ζ e dt — não da partícula
 * — logo calculam-se uma vez por fotograma e por classe de rigidez, e o custo
 * por partícula fica igual ao do Euler. O que se ganha é que a trajetória é
 * idêntica a qualquer cadência, por construção, e o integrador é
 * incondicionalmente estável.
 *
 * ---------------------------------------------------------------------------
 * O CAMPO DE CORRENTES, E PORQUÊ NÃO UMA MOLA COM RUÍDO
 *
 * A primeira versão deste ficheiro prendia TODAS as partículas, mesmo as do
 * campo: cada uma tinha uma âncora fixa e oscilava à volta dela com uma soma
 * de senos. Lê-se mal. Uma letra presa a um ponto treme; não voa. E como cada
 * uma tem a sua fase, o conjunto não tem direção nenhuma — é ruído, não é
 * vento.
 *
 * Aqui a partícula livre não tem destino: tem uma VELOCIDADE pretendida, lida
 * de um campo que varia devagar no espaço e no tempo. Partículas vizinhas
 * recebem direções parecidas, por isso movem-se em correntes; o campo roda
 * devagar, por isso as correntes mudam; e a velocidade persegue a pretendida
 * com um filtro lento, por isso nada muda de direção em bico.
 *
 * O CAMPO TEM DE SER CONSERVATIVO, E ISSO NÃO É PEDANTISMO
 *
 * A segunda versão lia um ângulo de um campo escalar e usava (cosθ, sinθ)
 * como velocidade. Parece inofensivo e não é: um campo assim tem fontes e
 * sumidouros. As partículas drenam de umas regiões e empilham-se noutras, e
 * em meio minuto o ecrã fica com zonas vazias ao lado de zonas com sete vezes
 * a densidade média. Medido: células com 0 letras ao lado de células com 331,
 * contra uma média de 48.
 *
 * A correção é clássica e custa o mesmo: em vez de ler a direção de um campo
 * escalar ψ, toma-se o seu ROTACIONAL, v = (∂ψ/∂y, −∂ψ/∂x). Um campo
 * assim tem divergência nula por construção — preserva área, como um fluido
 * incompressível — e por isso a densidade mantém-se, sem fontes nem
 * sumidouros. Ganha-se de borla o que se queria: as linhas de corrente
 * fecham-se em vórtices, e vórtices lêem-se como vento.
 *
 * O preço é que a velocidade deixa de ser constante: anula-se no centro de
 * cada vórtice e é máxima entre eles. É o comportamento certo — um fluido faz
 * isso — e é o que faz o campo respirar em vez de desfilar.
 *
 * E MESMO ASSIM ELAS ACUMULAM-SE: A AMARRA
 *
 * Um campo de divergência nula preserva a área do FLUIDO. As letras não são o
 * fluido: seguem-no com atraso, porque têm inércia. E uma partícula inerte
 * num escoamento não acompanha as linhas de corrente — passa mais tempo onde
 * o campo é lento, que é precisamente o centro dos vórtices. Ao fim de dois
 * minutos o ecrã tinha células vazias ao lado de células com sete vezes a
 * média. Medido, e pior do que a versão anterior: é um efeito conhecido, a
 * concentração preferencial de partículas inerciais.
 *
 * A amarra resolve-o sem tirar nada ao voo. Cada letra tem uma zona sua, e
 * uma mola muito fraca — frequência angular de um terço de radiano por
 * segundo, dezenas de vezes mais lenta do que a que compõe um rosto — que a
 * puxa de volta. Durante segundos a corrente manda e a letra voa; ao fim de
 * uma dezena, a amarra já se fez sentir e ela vagueia de volta. Como as zonas
 * estão uniformemente distribuídas, a densidade mantém-se; como a mola é
 * fraca, ninguém a vê.
 */

import { clamp } from '../core/math.js';

/**
 * Perfis de mola, um por comportamento.
 *
 * ζ varia conforme o que está em causa: num rosto 0.88 é quase imperceptível
 * mas mantém o perfil de velocidade vivo; num poema é exatamente 1, porque
 * tipografia que ressalta ao aterrar lê-se como erro, não como poesia.
 *
 * @readonly
 */
export const SPRINGS = {
  /**
   * Palavras que se formam no campo. É o perfil em vigor na página inicial,
   * onde as únicas partículas presas são as de uma palavra.
   *
   * A respiração é quase nula, e tem de ser: uma letra presa a um destino
   * oscila em torno dele com amplitude `amp × drift`, e com a respiração alta
   * do campo isso dava quase vinte píxeis por letra. Uma palavra cujas letras
   * bailam vinte píxeis cada uma não se lê como palavra — lê-se como letras a
   * mexer, que é exatamente o que ela deixou de ser ao formar-se.
   */
  word: { omega: 5.4, zeta: 0.95, drift: 0.06, lift: 0 },

  /** Composição de um rosto: firme, para o desenho não tremer. */
  portrait: { omega: 6.2, zeta: 0.88, drift: 0.05, lift: 0 },

  /** Grelha de um poema: a mais rápida, e a única criticamente amortecida. */
  poem: { omega: 8.2, zeta: 1, drift: 0.02, lift: 0 },
};

/**
 * Classes de rigidez: multiplicadores de ω atribuídos no nascimento.
 *
 * Servem para dessincronizar a multidão. Com um só ω, três mil letras chegam
 * ao destino no mesmo instante e a transição lê-se como um estore a fechar.
 * Seis classes — e não três mil — porque os coeficientes da matriz são
 * pré-calculados por classe: seis exponenciais por fotograma, em vez de três
 * mil.
 *
 * @readonly
 */
export const STIFFNESS_CLASSES = [0.78, 0.87, 0.96, 1.04, 1.13, 1.24];

/**
 * O campo de correntes.
 *
 * `frequency` é o inverso da escala espacial: 0.0022 dá células com cerca de
 * 450 px, o que faz um ecrã conter três ou quatro correntes distintas. Mais
 * alto e o campo vira turbulência; mais baixo e todo o ecrã anda para o mesmo
 * lado.
 *
 * `timeScale` é a lentidão com que o campo roda. A 0.085 rad/s, uma corrente
 * leva mais de um minuto a inverter-se — ninguém vê o padrão a repetir-se,
 * mas o ecrã nunca está duas vezes igual.
 *
 * `steering` é a rapidez com que a partícula adota a velocidade do campo. É
 * aqui que está a diferença entre voar e ser arrastado: baixo, a letra tem
 * inércia e descreve curvas; alto, cola-se ao campo e o movimento fica
 * mecânico.
 *
 * @readonly
 */
export const FLOW = {
  frequency: 0.0022,
  timeScale: 0.085,
  steering: 0.85,
  /* A velocidade de cruzeiro sobe face à versão anterior porque o rotacional
     a modula entre zero e cerca do dobro: o que se declara aqui é o pico, e a
     média fica mais ou menos em metade. */
  speedMin: 34,
  speedMax: 73,
  /** Deslocamento de fase por partícula. Pequeno de propósito: a zero, duas
   *  letras no mesmo sítio andam exatamente juntas para sempre; grande de
   *  mais, cada uma segue a sua corrente e perde-se a noção de vento. */
  jitter: 0.09,
  /** Margem fora do ecrã onde a partícula dá a volta, em píxeis. */
  margin: 90,
  /**
   * Frequência angular da amarra, em rad/s. Compare-se com os 6.2 que compõem
   * um rosto: é dezoito vezes mais lenta, e por isso nunca se lê como uma
   * mola — lê-se como a letra ter um bairro.
   */
  tether: 0.38,
};

/**
 * A inclinação das letras em voo.
 *
 * Uma letra que se desloca para a direita inclina-se para a esquerda, como
 * quem corre contra o ar. É um exagero deliberado — a física não faz isto — e
 * é o que separa um campo de letras a deslizar de um campo de letras a voar.
 *
 * O ângulo persegue o alvo com um filtro próprio, mais rápido do que o da
 * velocidade: a inclinação tem de responder à curva, não atrasar-se dela.
 *
 * @readonly
 */
const TILT = {
  /** Inclinação máxima, em radianos. 0.34 são cerca de 19 graus. */
  max: 0.34,
  /**
   * Velocidade horizontal, em px/s, a que se atinge a inclinação máxima.
   *
   * Medido: a velocidade de cruzeiro do campo ronda os 22 px/s, o que com
   * este valor dá cerca de onze graus — visível, e longe do limite. Os
   * dezanove graus do máximo ficam reservados para quando o cursor atira uma
   * letra, que é quando a inclinação tem mesmo de se notar.
   */
  speed: 60,
  /** Rapidez do ajuste, em unidades por segundo. */
  lambda: 4.5,
};

/**
 * A zona de ar à volta de um poema.
 *
 * Enquanto um poema se escreve, as letras que não lhe pertencem não podem
 * estar por cima dele. A primeira tentativa foi EXPULSÁ-LAS: uma força que as
 * empurrava para fora do retângulo do texto, pela saída mais curta. Foi um
 * erro, e um erro instrutivo. Para uma letra no meio do bloco, a saída mais
 * curta é para cima ou para baixo — ou seja, atravessando todos os versos. E
 * como o campo de correntes as trazia de volta, formava-se uma fila
 * permanente encostada ao texto. O resultado era exatamente o contrário do
 * pretendido: entulho entre as letras do poema.
 *
 * A solução é não lutar com elas. As letras continuam a voar como voavam, a
 * atravessar a página como qualquer outra — simplesmente não se DESENHAM
 * dentro da mancha do texto. Não há força nenhuma, não há acumulação, não há
 * nada a contrariar o movimento. O poema passa a ter ar à volta porque o ar
 * é o que lá está.
 *
 * `core` é a fração interior onde a letra está completamente invisível; entre
 * essa fração e o bordo da zona, reaparece com uma rampa suave, para que não
 * se veja uma moldura retangular a cortar o campo.
 */
const VEIL = {
  core: 0.55,
};

/**
 * Campo de forças do cursor.
 *
 * A queda é um smoothstep sobre a distância normalizada. Porquê não as outras:
 * a linear deixa um disco de bordo nítido a passear pelo ecrã; o inverso do
 * quadrado varia 400 para 1 entre 5 px e 100 px, o que lê como explosão; a
 * quadrática tem o gradiente máximo no centro e as letras debaixo do cursor
 * arrancam com violência. O smoothstep tem derivada nula nos DOIS extremos, e
 * o planalto central faz com que as letras próximas sejam empurradas quase
 * todas com a mesma força — que é a leitura de pó a ser afastado.
 *
 * Falta um detalhe que quase toda a gente erra: um campo vetorial radial
 * contínuo TEM de se anular no centro, porque lá a direção é indefinida. Com
 * magnitude máxima no centro, a direção inverte-se bruscamente sempre que o
 * cursor passa por cima de uma letra, e vê-se um estalo. A rampa interior
 * resolve: abaixo de `innerRatio · raio` divide-se pelo raio interior em vez
 * de pela distância, e a aceleração decresce linearmente até zero.
 *
 * @readonly
 */
export const POINTER = {
  radiusRatio: 0.15,
  radiusMin: 180,
  radiusMax: 420,
  innerRatio: 0.06,
  strength: 2800,
  restFraction: 0.35,
  fullSpeed: 1200,
  /** Componente tangencial, que transforma "afastamento" em "pó arrastado". */
  swirl: 0.22,
};

/** Travão de velocidade, em píxeis de CSS por segundo. */
const MAX_SPEED = 2600;
const MAX_SPEED_SQ = MAX_SPEED * MAX_SPEED;

/**
 * Abaixo deste ζ usa-se o ramo subamortecido; acima, o criticamente
 * amortecido. O limiar não deve descer: é ele que evita a divisão por
 * ωd = ω√(1−ζ²) quando ζ se aproxima de 1.
 */
const CRITICAL_EPSILON = 0.999;

/**
 * @typedef {object} TransitionCoefficients
 * @property {number} p11
 * @property {number} p12
 * @property {number} p21
 * @property {number} p22
 */

/**
 * Matriz de transição e^(A·dt) do oscilador, com A = [[0, 1], [−ω², −2ζω]].
 *
 * Aplicada ao desvio em relação ao destino, u = x − destino, e à velocidade:
 *     u(t+dt) = p11·u + p12·v
 *     v(t+dt) = p21·u + p22·v
 *
 * @param {number} omega
 * @param {number} zeta
 * @param {number} dt
 * @param {TransitionCoefficients} out Objeto reutilizado, para não alocar.
 * @returns {TransitionCoefficients}
 */
function transitionMatrix(omega, zeta, dt, out) {
  const decay = Math.exp(-zeta * omega * dt);

  if (zeta < CRITICAL_EPSILON) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const cos = Math.cos(wd * dt);
    const sin = Math.sin(wd * dt);
    const k = (zeta * omega) / wd;

    out.p11 = decay * (cos + k * sin);
    out.p12 = (decay * sin) / wd;
    out.p21 = ((-omega * omega) / wd) * decay * sin;
    out.p22 = decay * (cos - k * sin);
    return out;
  }

  // Criticamente amortecido: é o limite do ramo acima quando ωd → 0, e tem de
  // ser escrito à parte porque lá aparece uma divisão por ωd.
  const wt = omega * dt;
  out.p11 = decay * (1 + wt);
  out.p12 = decay * dt;
  out.p21 = -omega * omega * dt * decay;
  out.p22 = decay * (1 - wt);
  return out;
}

/** Coeficientes por classe, alocados uma vez no carregamento do módulo. */
const COEFFICIENTS = STIFFNESS_CLASSES.map(() => ({ p11: 0, p12: 0, p21: 0, p22: 0 }));

/**
 * @typedef {object} VeilRect
 * @property {number} cx Centro, em píxeis de CSS.
 * @property {number} cy
 * @property {number} halfWidth
 * @property {number} halfHeight
 */

/**
 * @typedef {object} StepConfig
 * @property {number} omega Frequência base; cada classe multiplica-a.
 * @property {number} zeta
 * @property {number} drift Respiração das partículas presas, em [0, 1].
 * @property {boolean} pointerActive
 * @property {number} pointerX
 * @property {number} pointerY
 * @property {number} pointerRadius
 * @property {number} pointerSpeed
 * @property {number} alphaLambda
 * @property {number} width Largura do viewport, para o campo dar a volta.
 * @property {number} height
 * @property {boolean} tilt Se as letras em voo se inclinam.
 * @property {VeilRect | null} veil Mancha de um poema em construção, onde as
 *   letras que não lhe pertencem deixam de ser desenhadas.
 */

/**
 * Avança todas as partículas um passo.
 *
 * É a função mais quente do projeto: corre entre mil e seis mil vezes por
 * fotograma. Daí as decisões que parecem feias — tudo em arrays tipados, as
 * constantes copiadas para locais antes do ciclo, nenhuma chamada de função
 * lá dentro, nenhum objeto criado.
 *
 * @param {import('./system.js').ParticleBuffers} p
 * @param {StepConfig} cfg
 * @param {number} dt Segundos.
 * @param {number} time Segundos desde o arranque.
 */
export function stepParticles(p, cfg, dt, time) {
  const count = p.count;
  const {
    x, y, vx, vy, tx, ty, delay, phase, freq, amp, speed, angle,
    homeX, homeY, parallax, alpha, alphaTarget, stiffness, held,
  } = p;

  // --- Coeficientes da mola, uma vez por fotograma e por classe -----------
  for (let c = 0; c < STIFFNESS_CLASSES.length; c += 1) {
    transitionMatrix(cfg.omega * STIFFNESS_CLASSES[c], cfg.zeta, dt, COEFFICIENTS[c]);
  }

  const driftScale = cfg.drift;

  // --- Campo de correntes --------------------------------------------------
  const flowFreq = FLOW.frequency;
  const flowPhase = time * FLOW.timeScale;
  const flowJitter = FLOW.jitter;
  const tetherK = FLOW.tether * FLOW.tether;
  const steer = 1 - Math.exp(-FLOW.steering * dt);

  // --- Inclinação ----------------------------------------------------------
  const tiltOn = cfg.tilt;
  const tiltStep = 1 - Math.exp(-TILT.lambda * dt);
  const tiltScale = TILT.max / TILT.speed;

  // --- Campo do cursor -----------------------------------------------------
  const hasPointer = cfg.pointerActive;
  const radius = cfg.pointerRadius;
  const radiusSq = radius * radius;
  const innerRadius = radius * POINTER.innerRatio;
  const speedGain = POINTER.restFraction
    + (1 - POINTER.restFraction) * clamp(cfg.pointerSpeed / POINTER.fullSpeed, 0, 1);
  const pointerStrength = POINTER.strength * speedGain;
  const swirl = POINTER.swirl * clamp(cfg.pointerSpeed / POINTER.fullSpeed, 0, 1);
  const pointerX = cfg.pointerX;
  const pointerY = cfg.pointerY;

  // --- Zona de ar do poema -------------------------------------------------
  const veilRect = cfg.veil;
  const veCx = veilRect ? veilRect.cx : 0;
  const veCy = veilRect ? veilRect.cy : 0;
  const veHalfW = veilRect ? veilRect.halfWidth : 1;
  const veHalfH = veilRect ? veilRect.halfHeight : 1;
  const veCore = VEIL.core;
  const veSpan = 1 - veCore;

  // Frações de caminho percorridas neste passo. Em exponencial e não em
  // fração fixa por fotograma, para que o resultado não dependa da cadência.
  const alphaStep = 1 - Math.exp(-cfg.alphaLambda * dt);

  for (let i = 0; i < count; i += 1) {
    // --- Atraso escalonado -------------------------------------------------
    // Enquanto o contador não chega a zero a partícula não é puxada para o
    // destino. É isto que faz um poema ser escrito verso a verso.
    let wait = delay[i];
    if (wait > 0) {
      wait -= dt;
      delay[i] = wait > 0 ? wait : 0;
    }

    const settling = held[i] === 1 && wait <= 0;

    let nvx = vx[i];
    let nvy = vy[i];

    if (settling) {
      // --- Mola, em forma fechada -----------------------------------------
      // A respiração entra como deslocamento do DESTINO e não como força:
      // assim a mola funciona como filtro passa-baixo, a amplitude é
      // previsível em píxeis, e desaparece sozinha nas transições porque o
      // destino é substituído.
      const ph = phase[i];
      const f = freq[i];
      const a = amp[i] * driftScale;
      const goalX = tx[i] + Math.sin(time * f + ph) * a;
      const goalY = ty[i] + Math.cos(time * f * 0.83 + ph * 1.7) * a * 0.75;

      // Cursor antes da mola, por separação de operadores.
      if (hasPointer) {
        const dx = x[i] - pointerX;
        const dy = y[i] - pointerY;
        const distSq = dx * dx + dy * dy;
        if (distSq < radiusSq) {
          const dist = Math.sqrt(distSq);
          const q = 1 - dist / radius;
          const falloff = q * q * (3 - 2 * q);
          const magnitude = (pointerStrength * falloff * parallax[i])
            / (dist > innerRadius ? dist : innerRadius);
          nvx += (dx * magnitude - dy * magnitude * swirl) * dt;
          nvy += (dy * magnitude + dx * magnitude * swirl) * dt;
        }
      }

      const coef = COEFFICIENTS[stiffness[i]];
      const ux = x[i] - goalX;
      const uy = y[i] - goalY;

      // Posição e velocidade calculadas AMBAS a partir da velocidade antiga.
      // Escrever a velocidade primeiro misturaria as linhas da matriz e
      // introduziria amortecimento dependente de dt — um erro que deixa o
      // sistema estável e plausível, e por isso passa despercebido.
      const px = goalX + coef.p11 * ux + coef.p12 * nvx;
      const py = goalY + coef.p11 * uy + coef.p12 * nvy;
      const qvx = coef.p21 * ux + coef.p22 * nvx;
      const qvy = coef.p21 * uy + coef.p22 * nvy;

      x[i] = px;
      y[i] = py;
      nvx = qvx;
      nvy = qvy;
    } else {
      // --- Voo livre -------------------------------------------------------
      // O potencial, em duas oitavas:
      //   ψ = sin(u)·cos(v) + ½·sin(2.3u)·cos(1.7v)
      // e a velocidade é o seu rotacional, (∂ψ/∂y, −∂ψ/∂x). A segunda
      // oitava, mais apertada e a rodar noutro sentido, quebra a regularidade
      // da primeira sem lhe tirar a coerência.
      const desvio = phase[i] * flowJitter;
      const u = x[i] * flowFreq + flowPhase + desvio;
      const v = y[i] * flowFreq - flowPhase * 0.8 + desvio;

      const su = Math.sin(u);
      const cu = Math.cos(u);
      const sv = Math.sin(v);
      const cv = Math.cos(v);

      const u2 = u * 2.3 - flowPhase * 1.4;
      const v2 = v * 1.7 + flowPhase * 1.7;
      const su2 = Math.sin(u2);
      const cu2 = Math.cos(u2);
      const sv2 = Math.sin(v2);
      const cv2 = Math.cos(v2);

      const dPsiDy = -su * sv - 0.85 * su2 * sv2;
      const dPsiDx = cu * cv + 1.15 * cu2 * cv2;

      const s = speed[i];
      const wantX = dPsiDy * s;
      const wantY = -dPsiDx * s;

      nvx += (wantX - nvx) * steer;
      nvy += (wantY - nvy) * steer;

      // A amarra. Uma aceleração, não uma correção de posição: assim soma-se
      // à corrente em vez de a contrariar, e a letra descreve uma curva de
      // volta em vez de ser puxada por um elástico.
      nvx += (homeX[i] - x[i]) * tetherK * dt;
      nvy += (homeY[i] - y[i]) * tetherK * dt;

      if (hasPointer) {
        const dx = x[i] - pointerX;
        const dy = y[i] - pointerY;
        const distSq = dx * dx + dy * dy;
        if (distSq < radiusSq) {
          const dist = Math.sqrt(distSq);
          const q = 1 - dist / radius;
          const falloff = q * q * (3 - 2 * q);
          const magnitude = (pointerStrength * falloff * parallax[i])
            / (dist > innerRadius ? dist : innerRadius);
          nvx += (dx * magnitude - dy * magnitude * swirl) * dt;
          nvy += (dy * magnitude + dx * magnitude * swirl) * dt;
        }
      }

      // Sem dar a volta pela outra borda. Havia-a, e entrava em conflito com
      // a amarra: uma letra que saísse pela direita e reaparecesse à esquerda
      // ficava à largura de um ecrã da sua zona, e a amarra mandava-a de volta
      // a atravessar tudo a correr. Agora não é preciso — a amarra é que trata
      // de ninguém se afastar, e uma letra cuja zona fique à beira do ecrã sai
      // e volta, que é o que uma letra ao vento faz.
      x[i] += nvx * dt;
      y[i] += nvy * dt;
    }

    const speedSq = nvx * nvx + nvy * nvy;
    if (speedSq > MAX_SPEED_SQ) {
      const scale = MAX_SPEED / Math.sqrt(speedSq);
      nvx *= scale;
      nvy *= scale;
    }

    vx[i] = nvx;
    vy[i] = nvy;

    // --- Inclinação --------------------------------------------------------
    if (tiltOn) {
      const wanted = -clamp(nvx * tiltScale, -TILT.max, TILT.max);
      angle[i] += (wanted - angle[i]) * tiltStep;
    } else if (angle[i] !== 0) {
      angle[i] += (0 - angle[i]) * tiltStep;
    }

    // --- Opacidade ---------------------------------------------------------
    // A zona de ar do poema entra aqui, e só aqui: é um desconto na
    // opacidade, não uma força. Quem pertence ao poema (settling) está isento.
    let wanted = alphaTarget[i];

    if (veilRect && !settling) {
      const nx = (x[i] - veCx) / veHalfW;
      const ny = (y[i] - veCy) / veHalfH;
      const dentro = Math.max(nx < 0 ? -nx : nx, ny < 0 ? -ny : ny);

      if (dentro < 1) {
        // Rampa de Hermite entre o núcleo e o bordo: derivada nula nas duas
        // pontas, por isso não se vê onde a zona começa nem onde acaba.
        const q = clamp((dentro - veCore) / veSpan, 0, 1);
        wanted *= q * q * (3 - 2 * q);
      }
    }

    alpha[i] += (wanted - alpha[i]) * alphaStep;
  }
}
