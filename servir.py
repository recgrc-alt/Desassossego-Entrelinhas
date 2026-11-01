#!/usr/bin/env python3
"""Servidor de desenvolvimento para o Desassossego Entrelinhas.

PORQUE É QUE ISTO É PRECISO
Este site não funciona aberto a partir do disco, com um duplo clique no
index.html. Não é uma limitação do código — é como os browsers funcionam:

  * No protocolo file://, os módulos de JavaScript são pedidos em modo CORS e
    bloqueados. O site nem chega a arrancar.
  * Desenhar uma fotografia local num canvas contamina-o, e o getImageData
    que lê os píxeis do retrato passa a lançar SecurityError. É assim no
    Chrome, no Firefox e no Safari, e não há opção que o contorne.

Qualquer servidor de HTTP resolve as duas coisas. Este faz mais uma: manda os
ficheiros sempre sem cache, para que ao gravar um CSS e recarregar a página se
veja a alteração e não a versão de há cinco minutos. O `python -m http.server`
não faz isso, e perde-se muito tempo a depurar ficheiros antigos.

COMO SE USA

    python servir.py

e abre-se http://localhost:5173. Para outra porta, `python servir.py 8080`.
"""

import functools
import http.server
import os
import sys

PORTA_POR_OMISSAO = 5173

# A raiz é a pasta deste ficheiro, e não a pasta onde o comando foi dado:
# servir a partir de uma subpasta parte todos os caminhos do site.
RAIZ = os.path.dirname(os.path.abspath(__file__))


class Manipulador(http.server.SimpleHTTPRequestHandler):
    """Servidor estático sem cache e com os tipos de conteúdo certos."""

    # HTTP/1.1 para que a ligação seja reaproveitada. Com HTTP/1.0 o browser
    # abre e fecha uma ligação por ficheiro, e são mais de vinte.
    protocol_version = 'HTTP/1.1'

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        # Alguns Windows têm o registo de tipos MIME estragado e devolvem
        # .js como text/plain, o que faz o browser recusar o módulo. Fixar
        # aqui evita um erro que parece de código e é de sistema.
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, formato, *args):
        # Uma linha por pedido é ruído; só interessam os erros.
        codigo = args[1] if len(args) > 1 else ''
        if str(codigo).startswith(('4', '5')):
            super().log_message(formato, *args)


def main():
    porta = int(sys.argv[1]) if len(sys.argv) > 1 else PORTA_POR_OMISSAO
    manipulador = functools.partial(Manipulador, directory=RAIZ)

    # ThreadingHTTPServer, e não o TCPServer simples: um servidor de uma só
    # linha de execução atende um pedido de cada vez, e o browser abre seis
    # ligações em paralelo para ir buscar os vinte e tal módulos deste site.
    # As cinco que ficam à espera bloqueiam, e a página parece pendurada.
    with http.server.ThreadingHTTPServer(('127.0.0.1', porta), manipulador) as servidor:
        print(f'Desassossego Entrelinhas em http://localhost:{porta}')
        print(f'a servir {RAIZ}')
        print('Ctrl+C para parar.')
        try:
            servidor.serve_forever()
        except KeyboardInterrupt:
            print('\nParado.')


if __name__ == '__main__':
    main()
