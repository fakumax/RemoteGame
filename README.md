# RemoteGame

Biblioteca de ROMs para jugar desde un navegador. Lee la colección sin modificarla; las subidas se guardan únicamente en `roms/`.

## Inicio

Requiere Node.js 22 o posterior e Internet para cargar los emuladores fijados a EmulatorJS 4.2.3 y jsnes 1.2.1.

```powershell
npm run setup
npm start          # tu PC y tu red de casa
npm run share      # además, link por Internet con ngrok
```

Abrir http://localhost:3000 en la PC anfitriona. Al arrancar, la consola muestra la dirección para la misma red (por ejemplo `http://192.168.100.20:3000`) y, con `npm run share`, la de Internet.

`PORT` cambia el puerto. `GAMES_ROOT` cambia la carpeta de la colección; por defecto se busca `Desktop/GAMES LAUNCHBOX EMULATOR` dentro del perfil del usuario. Estructura esperada:

| Sistema | Carpeta dentro de GAMES_ROOT | Emulador |
| --- | --- | --- |
| NES | NES | jsnes (online) / EmulatorJS (local) |
| Genesis | Sega Genesis | segaMD |
| Arcade / Neo Geo | MAME/Roms | FBNeo o MAME 2003 |
| Super Nintendo | Super Nintendo/Roms | snes |
| Nintendo 64 | Nintendo 64/Roms | n64 |

PlayStation 1 está excluida por elección del usuario. PS2, PS3, Dreamcast, Naomi/Atomiswave y Model 2/3 de la colección no tienen integración en este proyecto.

## Jugar con otra persona

Cada juego tiene **2P online** y **2P local**.

- **2P online (SNES, Genesis, Arcade/Neo Geo, N64): streaming.** El juego corre en la pestaña del anfitrión, que transmite video y audio por WebRTC a resolución nativa. El invitado abre el link, ve el video y manda sus controles como P2 (teclado, mando o controles táctiles en el celu). No instala ni descarga nada y no puede desincronizarse. El anfitrión juega sin retraso; el invitado suma la ida y vuelta de la red más unos ms de codificación. La pestaña del anfitrión tiene que quedar visible: minimizada, el navegador frena el juego.
- **2P online (NES): lockstep.** Cada navegador corre jsnes y solo viajan los botones, con un delay configurable (2 frames por defecto). Cada paquete WebRTC repite los últimos 8 frames y, mientras la partida espera, se reenvían; así una pérdida de paquetes no congela la partida. Sin WebRTC, usa el WebSocket del servidor.
- **2P local:** P1 y P2 ya tienen mando (1.º y 2.º mando conectado) y teclado compartido (P1 `WASD` + `F G R T`, P2 flechas + `K L I O`).

### Links: misma red e Internet

La página del anfitrión muestra los links para compartir:

- **Misma red:** `http://<IP-de-esta-PC>:3000/...`. Windows tiene que permitir conexiones entrantes a Node en esa red: con la red marcada como *Pública* y la regla de bloqueo que crea Windows, los otros dispositivos no conectan. Marcá la red como *Privada* y permití Node (o el puerto 3000) en ese perfil.
- **Internet:** `npm run share` abre un túnel de ngrok (tiene que estar instalado y con authtoken). Por ngrok pasan solo las páginas y la señalización; video y controles van directo entre navegadores por WebRTC. ngrok gratis muestra una advertencia la primera vez: el invitado toca *Visit Site*.
- **CGNAT:** si una de las dos conexiones no permite conexión directa, WebRTC necesita un relay TURN. Configurarlo con `TURN_URLS` (separadas por coma), `TURN_USERNAME` y `TURN_CREDENTIAL`. Sin TURN, el invitado ve un aviso a los 15 segundos.

Con el túnel activo, cualquiera que tenga el link ve la biblioteca. Subir ROMs solo se permite desde la PC anfitriona.

## ROMs y BIOS

Los ZIP de arcade se entregan íntegros. En el modo NES propio se extrae el archivo `.nes` en memoria, con un límite de 16 MB descomprimidos. En Subidos, un ZIP requiere elegir el emulador; no se adivina que todos los ZIP sean NES.

Neo Geo necesita `MAME/Roms/neogeo.zip`. Se sirve como `/neogeo.zip` y EmulatorJS lo escribe sin descomprimir junto a la ROM (`EJS_dontExtractBIOS`), porque FBNeo lo busca como ZIP; la copia original permanece intacta. También se enumeran los archivos de BIOS arcade presentes para el núcleo. Una ROM de MAME no es necesariamente compatible con FBNeo, y ciertos clones requieren un juego padre que no se resuelve automáticamente. No se descargan ROMs ni BIOS.

Fuentes de compatibilidad: [FAQ de EmulatorJS](https://emulatorjs.org/docs/faq/), [cliente fijado 4.2.3](https://cdn.emulatorjs.org/4.2.3/data/src/emulator.js), [FBNeo y ROM sets](https://docs.libretro.com/library/fbneo/).

## Verificación

```powershell
npm test
npm audit --omit=dev
npm audit --prefix netplay-node --omit=dev
```

Las pruebas usan archivos temporales propios y puertos libres. Cubren aislamiento de salas, desconexiones, rechazo de jugadores extra, validación de mensajes, sincronización inicial, descarte de generaciones antiguas, ZIPs sin alterar, BIOS y colas de controles acotadas bajo pausas y variación del retraso.

Para la prueba opcional con juegos de la colección, iniciar la aplicación en otra terminal y ejecutar:

```powershell
npm run test:browser
```

Requiere Microsoft Edge instalado. Abre navegadores de prueba sin ventana; usa Contra, Metal Slug, Sonic Eraser, Super Bomberman y Mario Kart 64 si están presentes. Compara el estado emulado de dos clientes NES en el mismo frame y guarda capturas/resultados en `test-results/`. El avance de frames solo prueba que el núcleo está ejecutándose: las capturas deben inspeccionarse, porque un núcleo puede mostrar un error de ROM mientras sigue avanzando. No es un benchmark de latencia de mando a pantalla ni una certificación de toda la colección.

`roms/`, dependencias, capturas, registros y archivos `.env` están excluidos de Git. No se realizó push.
