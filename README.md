# RemoteGame

Biblioteca de ROMs para jugar desde un navegador. Las ROMs de tu colección nunca se tocan (solo se leen); las subidas se guardan únicamente en `roms/`.

> **Este repositorio no incluye ni distribuye juegos, ROMs ni BIOS:** solo contiene el código del programa. Cada persona es responsable de los archivos que use con él y de tener derecho a hacerlo, por ejemplo copias de juegos que posee. Los nombres de juegos y consolas son marcas de sus dueños y este proyecto no tiene relación con ellos. EmulatorJS no se incluye: se carga desde su CDN. El software se ofrece "tal cual", sin garantías (ver [LICENSE](LICENSE)).

## Inicio

Si clonaste el repositorio, son tres pasos. Hace falta Node.js 22.13 o posterior, pnpm (`corepack enable` lo activa, viene con Node) e Internet (carga EmulatorJS 4.2.3 y baja las portadas).

```powershell
pnpm install
pnpm start         # biblioteca + sala online con link por Internet (ngrok)
pnpm local         # sin túnel: solo esta PC y tu red de casa
```

1. `pnpm install`.
2. `pnpm local` (o `pnpm start`, que además necesita ngrok instalado con su authtoken) y abrí http://localhost:3000.
3. La primera vez la página pregunta **¿Dónde están tus juegos?**: tocá **Buscar carpeta…** (en Windows abre el selector de carpetas), elegí la carpeta que contiene las de cada consola, revisá lo que encontró y tocá **Guardar**. Después se cambia con el botón ⚙️ junto al buscador.

LaunchBox **no hace falta**. Si lo tenés instalado, se aprovecha como extra (títulos, más portadas y los nombres de arcade de `MAME.xml`).

**Acceso directo en el escritorio:** apunta a `node.exe` con `server.js --open`, carpeta de inicio la del proyecto, e ícono `assets/remotegame.ico`. Con doble clic se abre la ventana del servidor y la biblioteca en el navegador. Si ya estaba abierto con el mismo código, solo abre el navegador (no corta una partida en curso); si estaba abierto con **otra versión** (después de actualizar el programa), le pide que se cierre y toma su lugar. Una versión muy vieja, que no entiende ese pedido, se cierra a mano: la consola lo avisa. Cerrar la ventana apaga el servidor y el túnel. No se empaqueta como `.exe`: Smart App Control de Windows bloquea ejecutables sin firma, mientras que `node.exe` está firmado por OpenJS Foundation.

Al arrancar, la consola muestra el **link para tu amigo** (con ngrok gratis es siempre el mismo dominio) y la dirección de tu red. Abrí http://localhost:3000 en tu PC.

`PORT` cambia el puerto.

**Carpeta de juegos.** Prioridad: la variable `GAMES_ROOT`, después `settings.json` (lo escribe la página; está ignorado por git) y por último `Desktop/GAMES LAUNCHBOX EMULATOR` dentro del perfil del usuario. Dentro de esa carpeta cada consola se busca **por el nombre de su subcarpeta**, hasta tres niveles de profundidad, y si adentro hay una carpeta `Roms` se usa esa cuando tiene más juegos. No se clasifica por extensión sola (un `.bin` de PlayStation pasaría por Genesis).

| Sistema | Nombres de carpeta reconocidos | Emulador |
| --- | --- | --- |
| NES | NES, Famicom, Nintendo Entertainment System | nes |
| Genesis | Genesis, Mega Drive, Sega Genesis, Sega Mega Drive | segaMD |
| Arcade / Neo Geo | MAME, Arcade, FBNeo, Neo Geo | FBNeo o MAME 2003-Plus (ver abajo) |
| Super Nintendo | SNES, Super Nintendo, Super Famicom | snes |
| Nintendo 64 | N64, Nintendo 64 | n64 |

Por ejemplo, `D:\Juegos\NES`, `D:\Juegos\Super Nintendo\Roms` o `D:\Consolas\Arcade\MAME\Roms` se reconocen solas.

PlayStation 1 está excluida por elección del usuario. PS2, PS3, Dreamcast, Naomi/Atomiswave y Model 2/3 de la colección no tienen integración en este proyecto.

## Jugar con otra persona

Hay **una sola sala, permanente, para hasta 3 amigos** (P2, P3 y P4; vos sos P1). Tus amigos abren el link una vez (desde PC o celu, sin instalar nada) y se quedan ahí. Vos elegís un juego y tocás **▶ Jugar**; sus pantallas muestran ese juego, y cuando volvés a la biblioteca y abrís otro, cambia sola, sin nuevo link ni recargar. Quien llega con la sala llena (ya hay 4 jugadores) ve un aviso y entra solo cuando alguien se va.

- **Streaming:** el juego corre en tu pestaña, que transmite video y audio por WebRTC a resolución nativa. Cada amigo manda sus controles con su número (teclado, mando o controles táctiles). No puede desincronizarse. Vos jugás sin retraso; ellos suman la ida y vuelta de la red más unos ms de codificación. **Ancho de banda:** tu PC sube un video por cada amigo (hasta 8 Mbps cada uno, normalmente bastante menos); con 3 amigos, contá con unos 3 videos de subida y la codificación de tres streams.
- **Filtro CRT:** líneas de barrido, máscara RGB y viñeta dibujadas con CSS encima de la imagen, sin trabajo por cuadro. No entra en el video transmitido: cada uno lo prende o apaga en su pantalla (📺 CRT) y queda recordado en ese navegador. Sigue visible en pantalla completa.
- **Ping y mandos:** arriba a la derecha de la pantalla de juego (también en pantalla completa) se ve la latencia en verde, amarillo o rojo; no entra en el video. En el encabezado, un indicador dice qué mando detectó el navegador (DualSense, Xbox…): los navegadores lo muestran recién cuando apretás un botón con la pestaña enfocada. Teclado y mandos se leen en la propia página, sin depender del foco, así que las flechas no mueven la página.
- **Cambio de red:** si un invitado pasa de WiFi a 4G (o al revés) o se corta la ruta, la sala se reconecta sola por la red nueva; también hay un botón 🔄 Reconectar. Cada pestaña de invitado guarda un identificador en el navegador (`localStorage`): al recargar o reconectarse recupera **el mismo jugador** (P2, P3 o P4). Un lugar que acaba de quedar libre se reserva unos segundos para su dueño.
- **Jugadores 3 y 4 según el juego:** funcionan directo en los **arcades de 4 jugadores** (TMNT, The Simpsons, X-Men, Sunset Riders… verificado con FBNeo) y en **Nintendo 64** (4 mandos de fábrica). En **Genesis** solo en juegos con cartucho J-Cart (p. ej. Micro Machines Turbo Tournament 96). En **NES** (Four Score) casi no andan: el núcleo lo activa solo para una lista de ROMs originales y los juegos traducidos o modificados no entran (Gauntlet II traducido no reconoció a P3 ni P4). En **SNES** (multitap) y en los juegos Genesis de 4-Way Play o Team Player no andan: son dispositivos del núcleo (no opciones) y EmulatorJS 4.2.3 no permite elegirlos. Ver [snes9x](https://docs.libretro.com/library/snes9x/), [Genesis Plus GX](https://docs.libretro.com/library/genesis_plus_gx/) y [FCEUmm](https://docs.libretro.com/library/fceumm/).
- **Nombres:** el nombre limpio del archivo (sin marcas como `[!]` o `(U)`), mejorado con el nombre No-Intro de la portada de libretro cuando coincide exacto. En arcade, el título sale de la lista pública de FinalBurn Neo (código corto de MAME → descripción, se baja una vez a `cache/libretro/`). Si tenés LaunchBox, su título tiene prioridad (`Data/Platforms/*.xml` y `Metadata/MAME.xml`, solo lectura; `LAUNCHBOX_DIR` cambia la carpeta).
- **Biblioteca:** las consolas están en un panel lateral y la búsqueda recorre todas (con una consola elegida, los resultados de otras aparecen debajo, en *En otras consolas*). Acepta varias palabras en cualquier orden, sin acentos ni signos, y también la ortografía en castellano de los títulos en inglés: «internacional» encuentra «International Superstar Soccer» (se busca además con *-tion* escrito *-cion*). La consola y la búsqueda se recuerdan al volver desde un juego. `GET /api/games` acepta `system` (`all` para todas), `q`, `limit`, `offset` y `not` (excluye una consola).
- **Portadas:** la fuente principal es [libretro-thumbnails](https://thumbnails.libretro.com/) (gratis, sin clave): se baja una vez por consola el listado de imágenes (`cache/libretro/`, se renueva al mes) y cada juego toma la que tiene **exactamente** su título una vez normalizado (sin región ni etiquetas; prefiere USA/Mundo, luego Europa; caja, si no pantalla de título, si no captura). Si tenés LaunchBox, es la segunda fuente (`Metadata/LaunchBox.Metadata.db`, por ID o por título exacto). Cada imagen se baja una vez, se achica con `sharp` a WebP de hasta 400 px (unos 35 KB) y se guarda en `cache/covers/` (se puede borrar sin problema; si `sharp` no carga se guarda la original). Si el juego no tiene portada en ninguna fuente, la tarjeta muestra un recuadro de color. **Portada propia:** poné en `<carpeta de la consola>\covers\` una imagen (`.png`, `.jpg` o `.webp`) con el mismo nombre que la ROM, sin la extensión (`Contra (U).png`), y se usa esa. Para que las portadas que se bajan también queden ahí, junto a los juegos y viajando con la colección, activalo con `"coversBesideGames": true` en `settings.json` (o `COVERS_IN_GAMES=1`); si esa carpeta no se puede escribir, se usa `cache/covers/`. Las ROMs nunca se modifican.
- **Arcade: qué núcleo corre cada juego.** Para cada ZIP de arcade se lee su directorio (nombres y CRC32, sin descomprimir) y se compara con las listas públicas de FBNeo y de MAME 2003-Plus: ¿existe el set?, ¿están sus ROMs?, ¿falta el juego padre o el BIOS?, ¿pide un disco CHD? El juego se abre con FBNeo si puede, si no con MAME 2003-Plus; los que ninguno puede aparecen atenuados con la etiqueta *No compatible*, el motivo en el tooltip y el botón *Probar igual*. Los juegos con CHD no andan todavía: los navegadores leen hasta la versión 3 y la página no entrega el archivo. MAME 2003 (0.78) no se usa: su compilación en EmulatorJS 4.2.3 falla con todos los juegos probados.
- **Ajustes de la carpeta de juegos (API):** `GET /api/settings`, `POST /api/settings/scan`, `POST /api/settings` y `POST /api/settings/pick` solo responden a esta PC y exigen el encabezado `X-RemoteGame: settings`; quien entra por el link del túnel nunca ve rutas.
- **Tu pestaña tiene que quedar visible:** minimizada, el navegador frena el juego para los dos.
- **Solo tu PC es anfitriona.** Quien entra por el link cae en la sala (`/sala`), no en la biblioteca, y no puede abrir juegos ni subir ROMs.
- **Local en la misma PC (hasta 4 mandos):** desde la página del juego, *Jugar en esta PC* (el mando N es el jugador N; P1 y P2 también con teclado compartido: P1 `WASD` + `F G R T`, P2 flechas + `K L I O`).

### Conexión

- **Internet:** por ngrok pasan solo las páginas y la señalización; video y controles van directo entre navegadores. ngrok gratis muestra una advertencia la primera vez: tu amigo toca *Visit Site*.
- **Misma red:** `http://<IP-de-esta-PC>:3000`. Windows tiene que permitir conexiones entrantes a Node: con la red marcada como *Pública* (y la regla de bloqueo que crea Windows) los otros dispositivos no conectan. Marcá la red como *Privada* y permití el puerto 3000 en ese perfil.
- **CGNAT:** si alguna de las dos conexiones no permite conexión directa, WebRTC necesita un relay TURN: `TURN_URLS` (separadas por coma), `TURN_USERNAME` y `TURN_CREDENTIAL`. Sin TURN, tu amigo ve un aviso a los 15 segundos.

`public/play.html` conserva el modo NES por lockstep (cada navegador emula y solo viajan los botones), ya no enlazado desde la biblioteca.

## ROMs y BIOS

Los ZIP de arcade se entregan íntegros. En el modo NES propio se extrae el archivo `.nes` en memoria, con un límite de 16 MB descomprimidos. En Subidos, un ZIP requiere elegir el emulador; no se adivina que todos los ZIP sean NES.

Neo Geo necesita `MAME/Roms/neogeo.zip`. Se sirve como `/neogeo.zip` y EmulatorJS lo escribe sin descomprimir junto a la ROM (`EJS_dontExtractBIOS`), porque FBNeo lo busca como ZIP; la copia original permanece intacta. También se enumeran los archivos de BIOS arcade presentes para el núcleo. Una ROM de MAME no es necesariamente compatible con FBNeo, y ciertos clones requieren un juego padre: la biblioteca lo detecta y lo marca (ver *Arcade: qué núcleo corre cada juego*). Solo se le puede entregar al emulador un BIOS (`neogeo`, `pgm` o `skns`). No se descargan ROMs ni BIOS.

Fuentes de compatibilidad: [FAQ de EmulatorJS](https://emulatorjs.org/docs/faq/), [cliente fijado 4.2.3](https://cdn.emulatorjs.org/4.2.3/data/src/emulator.js), [FBNeo y ROM sets](https://docs.libretro.com/library/fbneo/).

## Verificación

```powershell
pnpm test
pnpm audit --prod
```

Las pruebas usan archivos temporales propios y puertos libres. Cubren aislamiento de salas, desconexiones, rechazo de jugadores extra, validación de mensajes, sincronización inicial, descarte de generaciones antiguas, ZIPs sin alterar, BIOS y colas de controles acotadas bajo pausas y variación del retraso.

Para la prueba opcional con juegos de la colección, iniciar la aplicación en otra terminal y ejecutar:

```powershell
pnpm test:browser
```

Requiere Microsoft Edge instalado. Abre navegadores de prueba sin ventana; usa Contra, Metal Slug, Sonic Eraser, Super Bomberman y Mario Kart 64 si están presentes. Compara el estado emulado de dos clientes NES en el mismo frame y guarda capturas/resultados en `test-results/`. El avance de frames solo prueba que el núcleo está ejecutándose: las capturas deben inspeccionarse, porque un núcleo puede mostrar un error de ROM mientras sigue avanzando. No es un benchmark de latencia de mando a pantalla ni una certificación de toda la colección.

`roms/`, `cache/`, dependencias, capturas, registros y archivos `.env` están excluidos de Git.
