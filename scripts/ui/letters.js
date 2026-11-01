/**
 * @file letters.js
 * Parte um texto em letras, para que cada uma possa ser animada por si.
 *
 * Existe para a saudação de entrada, que aparece e desaparece da esquerda
 * para a direita: isso exige um atraso diferente por carácter, e um atraso
 * diferente por carácter exige um elemento por carácter. Não há maneira de o
 * fazer só com CSS sobre um nó de texto.
 *
 * O ÍNDICE VAI NUMA PROPRIEDADE PERSONALIZADA, não numa regra de estilo.
 * O caderno de encargos proíbe estilos inline, e com razão — mas abre a
 * exceção para valores que só o JavaScript pode calcular. É exatamente este
 * caso: o CSS não sabe quantas letras tem a palavra nem em que posição está
 * cada uma. O que se escreve aqui é um número; a duração, a curva e o que o
 * atraso significa continuam todos em intro.css.
 *
 * ACESSIBILIDADE
 * Uma palavra partida em onze elementos é lida por alguns leitores de ecrã
 * letra a letra — "b, e, m, hífen, v, i, n, d, o". Por isso o elemento passa
 * a ser anunciado como um todo, pelo seu rótulo, e os pedaços desaparecem da
 * árvore de acessibilidade. É a mesma convenção que se usa para um logótipo
 * desenhado com texto.
 */

/**
 * Parte o conteúdo de um elemento em letras.
 *
 * O texto original é lido antes de ser destruído e volta como rótulo, para
 * que o significado não se perca na divisão.
 *
 * @param {HTMLElement} element
 * @returns {number} Quantas letras ficaram.
 */
export function splitIntoLetters(element) {
  const text = (element.textContent || '').trim();
  if (text === '') return 0;

  // O rótulo é posto antes de o conteúdo mudar, e só se ainda não existir —
  // um rótulo escrito à mão no HTML sabe sempre melhor do que um deduzido.
  if (!element.hasAttribute('aria-label')) {
    element.setAttribute('aria-label', text);
  }
  element.setAttribute('role', 'img');

  const fragment = document.createDocumentFragment();
  const chars = Array.from(text);

  for (let i = 0; i < chars.length; i += 1) {
    const span = document.createElement('span');
    span.className = 'letter';
    span.textContent = chars[i];
    span.setAttribute('aria-hidden', 'true');
    span.style.setProperty('--i', String(i));
    fragment.append(span);
  }

  // Uma única substituição: inserir letra a letra obrigaria o browser a
  // recalcular a composição onze vezes.
  element.replaceChildren(fragment);

  return chars.length;
}
