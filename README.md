# RemoteGame

Biblioteca de ROMs para jugar desde un navegador. Lee la colección sin modificarla; las subidas se guardan únicamente en `roms/`.

## Inicio

Requiere Node.js 22 o posterior, ngrok instalado con su authtoken e Internet para cargar EmulatorJS 4.2.3.

```powershell
npm run setup
npm start          # biblioteca + sala online con link por Internet (ngrok)
npm run local      # sin túnel: solo esta PC y tu red de casa
```

**Acceso directo en el escritorio:** apunta a `node.exe` con `server.js --open`, carpeta de inicio la del proyecto, e ícono `assets/remotegame.ico`. Con doble clic se abre la ventana del servidor y la biblioteca en el navegador; si ya estaba abierto, solo abre el navegador. Cerrar la ventana apaga el servidor y el túnel. No se empaqueta como `.exe`: Smart App Control de Windows bloquea ejecutables sin firma, mientras que `node.exe` está firmado por OpenJS Foundation.

Al arrancar, la consola muestra el **link para tu amigo** (con ngrok gratis es siempre el mismo dominio) y la dirección de tu red. Abrí http://localhost:3000 en tu PC.

`PORT` cambia el puerto. `GAMES_ROOT` cambia la carpeta de la colección; por defecto se busca `Desktop/GAMES LAUNCHBOX EMULATOR` dentro del perfil del usuario. Estructura esperada:

| Sistema | Carpeta dentro de GAMES_ROOT | Emulador |
| --- | --- | --- |
| NES | NES | nes |
| Genesis | Sega Genesis | segaMD |
| Arcade / Neo Geo | MAME/Roms | FBNeo o MAME 2003 |
| Super Nintendo | Super Nintendo/Roms | snes |
| Nintendo 64 | Nintendo 64/Roms | n64 |

PlayStation 1 está excluida por elección del usuario. PS2, PS3, Dreamcast, Naomi/Atomiswave y Model 2/3 de la colección no tienen integración en este proyecto.

## Jugar con otra persona

Hay **una sola sala, permanente**. Tu amigo abre el link una vez (desde PC o celu, sin instalar nada) y se queda ahí. Vos elegís un juego y tocás **▶ Jugar**; su pantalla muestra ese juego, y cuando volvés a la biblioteca y abrís otro, cambia sola, sin nuevo link ni recargar.

- **Streaming:** el juego corre en tu pestaña, que transmite video y audio por WebRTC a resolución nativa. Tu amigo manda sus controles como P2 (teclado, mando o controles táctiles). No puede desincronizarse. Vos jugás sin retraso; tu amigo suma la ida y vuelta de la red más unos ms de codificación.
- **Tu pestaña tiene que quedar visible:** minimizada, el navegador frena el juego para los dos.
- **Solo tu PC es anfitriona.** Quien entra por el link cae en la sala (`/sala`), no en la biblioteca, y no puede abrir juegos ni subir ROMs.
- **2P en la misma PC:** desde la página del juego, *Jugar 2P en esta PC* (mando 1 y 2, o teclado compartido: P1 `WASD` + `F G R T`, P2 flechas + `K L I O`).

### Conexión

- **Internet:** por ngrok pasan solo las páginas y la señalización; video y controles van directo entre navegadores. ngrok gratis muestra una advertencia la primera vez: tu amigo toca *Visit Site*.
- **Misma red:** `http://<IP-de-esta-PC>:3000`. Windows tiene que permitir conexiones entrantes a Node: con la red marcada como *Pública* (y la regla de bloqueo que crea Windows) los otros dispositivos no conectan. Marcá la red como *Privada* y permití el puerto 3000 en ese perfil.
- **CGNAT:** si alguna de las dos conexiones no permite conexión directa, WebRTC necesita un relay TURN: `TURN_URLS` (separadas por coma), `TURN_USERNAME` y `TURN_CREDENTIAL`. Sin TURN, tu amigo ve un aviso a los 15 segundos.

`public/play.html` conserva el modo NES por lockstep (cada navegador emula y solo viajan los botones), ya no enlazado desde la biblioteca.

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
