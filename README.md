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
- **Portadas:** la fuente principal es [libretro-thumbnails](https://thumbnails.libretro.com/) (gratis, sin clave): se baja una vez por consola el listado de imágenes (`cache/libretro/`, se renueva al mes) y cada juego toma la que tiene **exactamente** su título una vez normalizado (sin región ni etiquetas; prefiere USA/Mundo, luego Europa; caja, si no pantalla de título, si no captura). Si tenés LaunchBox, es la segunda fuente (`Metadata/LaunchBox.Metadata.db`, por ID o por título exacto). Cada imagen se baja una vez, se achica con `sharp` a WebP de hasta 400 px (unos 35 KB) y se guarda en `cache/covers/` (se puede borrar sin problema; si `sharp` no carga se guarda la original). Si el juego no tiene portada en ninguna fuente, la tarjeta muestra un recuadro de color. **Portada propia:** poné en `RemoteGame\covers\<sistema>\` una imagen (`.png`, `.jpg` o `.webp`) con el mismo nombre que la ROM, sin la extensión (`Contra (U).png`), y se usa esa en lugar de las descargadas. Los sistemas son `nes`, `genesis`, `arcade`, `snes`, `n64` y `subidos`. Las portadas que estaban en `<consola>\covers\` dentro de la carpeta de juegos no se leen: pasalas a esa carpeta. **RemoteGame nunca escribe en la carpeta de juegos** (ni portadas ni nada más) y las ROMs nunca se modifican.
- **Arcade: qué núcleo corre cada juego.** Para cada ZIP de arcade se lee su directorio (nombres y CRC32, sin descomprimir) y se compara con las listas públicas de FBNeo y de MAME 2003-Plus: ¿existe el set?, ¿están sus ROMs?, ¿falta el juego padre o el BIOS?, ¿pide un disco CHD? El juego se abre con FBNeo si puede, si no con MAME 2003-Plus; los que ninguno puede aparecen atenuados con la etiqueta *No compatible*, el motivo en el tooltip y el botón *Probar igual*. Los juegos con CHD no andan todavía: los navegadores leen hasta la versión 3 y la página no entrega el archivo. MAME 2003 (0.78) no se usa: su compilación en EmulatorJS 4.2.3 falla con todos los juegos probados.
- **Ajustes de la carpeta de juegos (API):** `GET /api/settings`, `POST /api/settings/scan`, `POST /api/settings` y `POST /api/settings/pick` solo responden a esta PC y exigen el encabezado `X-RemoteGame: settings`; quien entra por el link del túnel nunca ve rutas.
- **Tu pestaña tiene que quedar visible:** minimizada, el navegador frena el juego para los dos.
- **Solo tu PC es anfitriona.** Quien entra por el link cae en la sala (`/sala`), no en la biblioteca, y no puede abrir juegos ni subir ROMs.
- **Local en la misma PC (hasta 4 mandos):** desde la página del juego, *Jugar en esta PC* (el mando N es el jugador N; P1 y P2 también con teclado compartido: P1 `WASD` + `F G R T`, P2 flechas + `K L I O`).

### Conexión

- **Internet:** por ngrok pasan solo las páginas y la señalización; video y controles van directo entre navegadores. ngrok gratis muestra una advertencia la primera vez: tu amigo toca *Visit Site*. El interruptor **🌐 Amigos por Internet** de la biblioteca (y de la pantalla de juego) prende y apaga el túnel sin reiniciar; solo lo ve esta PC y su elección queda en `settings.json`. `pnpm local` y `--no-share` arrancan con el túnel apagado sin cambiar esa elección.
- **Misma red:** `http://<IP-de-esta-PC>:3000`. Windows tiene que permitir conexiones entrantes a Node: con la red marcada como *Pública* (y la regla de bloqueo que crea Windows) los otros dispositivos no conectan. Marcá la red como *Privada* y permití el puerto 3000 en ese perfil.
- **CGNAT:** si alguna de las dos conexiones no permite conexión directa, WebRTC necesita un relay TURN: `TURN_URLS` (separadas por coma), `TURN_USERNAME` y `TURN_CREDENTIAL`. Sin TURN, tu amigo ve un aviso a los 15 segundos.

`public/play.html` conserva el modo NES por lockstep (cada navegador emula y solo viajan los botones), ya no enlazado desde la biblioteca.

## Transmitir un emulador de la PC

Para los juegos que no corren en el navegador: Switch con Eden, Dreamcast con Flycast, arcades pesados con MAME, lo que abras en RetroArch. Abrís el emulador de tu PC y jugás con tu propio mando; RemoteGame captura su ventana (o la pantalla) con `getDisplayMedia` y la transmite por el mismo WebRTC de siempre a hasta 3 amigos. **Para ellos no cambia nada:** el mismo link de la sala (`/sala`), su joystick, teclado o celu, y nada para instalar.

1. Abrí el emulador y el juego en esta PC.
2. En la biblioteca tocá **📺 Transmitir un emulador** (o abrí `http://localhost:3000/stream.html`; tiene que ser `localhost`, el navegador solo deja capturar la pantalla desde ahí).
3. Si querés, escribí **¿A qué juegan?** (es el nombre que ven tus amigos; por defecto, *Juego de la PC*) y tocá **Elegir ventana o pantalla**. Elegí la ventana del emulador o la pantalla completa.
4. Pasales el link de siempre. Entran, ven lo que transmitís y juegan como P2, P3 y P4.
5. Dejá el emulador al frente. La pestaña de RemoteGame puede quedar detrás, pero no la cierres, y la ventana capturada no puede estar minimizada (el navegador deja de recibir cuadros). Si se corta la captura, la página lo avisa y el botón vuelve a elegir.

- **Audio:** capturando una ventana no hay audio. Para que tus amigos escuchen, **compartí la pantalla completa y marcá "Compartir audio del sistema"** (Chrome o Edge en Windows). Se manda todo lo que suena en la PC; la vista previa de la página va sin sonido para que no haga eco.
- **Controles:** **P1 es tu mando, que va directo al emulador** sin pasar por RemoteGame. P2–P4 son los invitados: sus botones y los dos sticks llegan a esta PC como mandos virtuales. En el celu los botones de la pantalla tienen nombres de Xbox (A/B/X/Y) y la cruceta es digital, sin stick analógico.
- **Video:** 60 cuadros por segundo, H.264 si el navegador lo tiene (si no, lo que haya) y hasta 15 Mbps por amigo; el selector **Calidad del video** de la página ofrece 8, 15 y 25 Mbps. Una pantalla de más de 1080p se achica a 1080p al enviarla. Con 3 amigos, contá con unos 45 Mbps de subida a 15 Mbps; si tu conexión no llega, bajá la calidad.
- **En la pantalla de tus amigos:** la imagen respeta la proporción real de lo capturado (16:9, 4:3…), sin el efecto pixelado de los juegos web, y el filtro CRT arranca apagado. La elección de CRT en este modo se guarda aparte (`remotegame-crt-native`) y no pisa la que cada uno tiene para los juegos del navegador.
- **Solo esta PC** puede transmitir: quien entra por el link del túnel no puede abrir `/stream.html` como anfitrión.

### Configurar los emuladores para P2–P4

**Mandos de tus amigos en emuladores de la PC (sin instalar nada).**

Los botones de tus amigos (P2–P4) llegan a esta PC y RemoteGame se los entrega al emulador **sin drivers ni programas extra**: a Eden como "mandos UDP" (protocolo DSU/cemuhook) y a MAME como teclado simulado. Los dos andan solos al arrancar RemoteGame; `http://localhost:3000/api/vpad` (solo esta PC) muestra el estado: puerto UDP, clientes conectados, teclado y qué lugares están ocupados.

**Eden (Switch 1)**

RemoteGame escucha en `127.0.0.1:26760`, solo en tu PC. El pad 0 de ese servidor queda sin conectar (es el tuyo: usás tu mando de siempre en P1); P2 es el pad 1, P3 el pad 2 y P4 el pad 3.

1. Abrí Eden y andá a **Emulación → Configurar → Controles**. Los nombres de los menús están tomados del código de Eden y pueden variar según la versión: confirmalo en la tuya.
2. Tocá **Avanzado** y, en el grupo **Otros**, tildá **Habilitar mandos UDP (no hace falta para el movimiento)** (en inglés, *Enable UDP controllers (not needed for motion)*). Sin esa casilla los mandos UDP no aparecen en la lista.
3. Mismo lugar, **Movimiento / Táctil → Configurar**: el servidor por defecto de Eden es justamente `127.0.0.1` puerto `26760`. Si no figura en la lista, escribilo y tocá **Agregar servidor** (el botón **Probar** avisa si llegan datos; hace falta que algún amigo ya esté jugando).
4. Esperá a que tus amigos entren a la sala y, en **Jugador 2**, elegí como dispositivo de entrada **UDP Controller 1**; en **Jugador 3**, **UDP Controller 2**; en **Jugador 4**, **UDP Controller 3**. Eden numera los pads en la lista tal cual los manda el servidor.
5. RemoteGame manda los botones como los de un DualShock 4, de forma posicional como en la sala: abajo = Cruz, derecha = Círculo, izquierda = Cuadrado, arriba = Triángulo, más cruceta, L1/R1, L2/R2, L3/R3, los dos sticks, Share (Select) y Options (Start). Si Eden no los asigna solo a los botones de Switch, asignalos a mano en esa misma pantalla (no verificado con Eden real).

Notas: un mando UDP aparece en la lista de Eden recién cuando su lugar tiene un amigo jugando (si todavía no figura, esperá a que entre y reabrí la pantalla de Controles). Cuando el amigo se va, RemoteGame manda un último paquete repetido, que es la forma en que Eden da de baja un mando. El movimiento (giroscopio) va quieto. Si otro programa ya usa el puerto 26760 (por ejemplo DS4Windows), RemoteGame sigue andando y lo avisa en `/api/vpad`; el puerto se cambia con `dsuPort` en `config.json` (y en Eden, el mismo número). **Sin verificar con Eden real:** los nombres exactos de los menús y de los dispositivos dependen de la versión; lo que sí se probó es el protocolo con un cliente aparte.

**MAME (suelto, arcades)**

MAME no tiene mandos "virtuales": RemoteGame le *teclea* las teclas de cada jugador con `SendInput`.

1. Agregá `-keyboardprovider win32` al lanzador, o escribí `keyboardprovider win32` en `mame.ini`. Hace falta porque por defecto MAME lee el teclado con `rawinput` y este descarta las teclas inyectadas por programa; con `win32` las ve ([documentación](https://docs.mamedev.org/commandline/commandline-all.html): "user-mode keyboard emulation tools [...] will almost certainly require the use of `-keyboardprovider win32`").
2. Dejá la **ventana de MAME al frente**. RemoteGame solo teclea mientras la ventana en primer plano sea `mame.exe`; si cambiás de programa suelta todo y no escribe nada en el otro. Al volver a MAME, las teclas que sus amigos sigan apretando se retoman.
3. Dejá **Bloq Num** activado: P4 usa el teclado numérico.
4. Teclas de cada jugador (las de fábrica de MAME, [docs.mamedev.org/usingmame/defaultkeys.html](https://docs.mamedev.org/usingmame/defaultkeys.html), teclado ANSI de EE. UU.):

| | Dirección (arriba, abajo, izq., der.) | Botones 1 a 6 | Start | Moneda |
| --- | --- | --- | --- | --- |
| P2 | `R` `F` `D` `G` | `A` `S` `Q` `W` `E` (el 6 no tiene tecla) | `2` | `6` |
| P3 | `I` `K` `J` `L` | `Ctrl` der., `Shift` der., `Enter` (4 a 6 sin tecla) | `3` | `7` |
| P4 | teclado numérico `8` `2` `4` `6` | `0`, `.`, `Enter` numérico (4 a 6 sin tecla) | `4` | `8` |

La cruceta y el stick izquierdo (pasado el 50 %) son las direcciones. Los botones salen en orden arcade: B = 1, A = 2, Y = 3, X = 4, L = 5, R = 6; Select = moneda y Start = Start (las teclas `5` a `8` son las monedas 1 a 4, así que P2 usa la `6`, P3 la `7` y P4 la `8`). MAME solo trae tres botones de fábrica para P3 y P4; si tu juego usa más, asignalos en MAME (Tab → Configurar controles). Si dos jugadores comparten tecla en un juego de pantalla compartida (los P1 de doble stick usan `E S D F` e `I J K L`), cambiá las teclas en MAME.

El programa se puede cambiar o ampliar con `keyTargets` en `config.json` (por ejemplo `["mame.exe", "flycast.exe", "retroarch.exe"]`). **Flycast y RetroArch:** probalos así, con el teclado, agregando su proceso a la lista y poniendo en cada uno las mismas teclas de arriba para los jugadores 2 a 4; todavía no están probados. Si no andan, quedan para más adelante.

El teclado se usa solo si hay un invitado jugando: PowerShell arranca recién con el primer botón de un amigo, no al abrir RemoteGame. Fuera de Windows queda deshabilitado, y si PowerShell no puede arrancar, `/api/vpad` dice por qué y el resto sigue andando.

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

`roms/`, `cache/`, `covers/`, dependencias, capturas, registros y archivos `.env` están excluidos de Git.
