# PlayStation in the browser

**Play it at [mohrt.github.io/playstation](https://mohrt.github.io/playstation/)**

A PlayStation emulator written from scratch in TypeScript: the R3000A CPU with its load and branch delay slots and COP0 exceptions; the GTE, which passes all 1,150 of the ps1-tests GTE command and register tests; a software GPU with flat, Gouraud-shaded and textured polygons, sprites and lines, 4-, 8- and 15-bit textures, texture windows, the four blending modes, dithering, the mask bit and 24-bit video; the MDEC that decodes full-motion video; the SPU's 24 voices with Gaussian interpolation, ADSR envelopes, pitch modulation, noise and reverb; the CD-ROM controller with CD audio and XA-ADPCM streams; DMA, the timers, pads, the DualShock and memory cards. Drop a `.cue` with its `.bin` files (or a `.chd` or `.pbp`, a single `.bin` or `.iso` disc image, or a PlayStation `.exe`) onto the page to play it.

It starts with [OpenBIOS](https://github.com/grumpycoders/pcsx-redux/tree/main/src/mips/openbios), the free BIOS written by the PCSX-Redux team, so no BIOS of your own is needed (see below). The emulation runs in a Web Worker, drawing through an OffscreenCanvas and sending its sound straight to an AudioWorklet, so the page stays responsive.

## Controls

- **Keyboard** (player 1): arrow keys for the D-pad; S, Z, X and C for triangle, square, cross and circle (laid out as on the pad); Q and E for L1 and R1; 1 and 3 for L2 and R2; Enter for Start and right Shift (or Backspace) for Select. Hold Tab or Space to fast-forward. P or Pause pauses the emulator.
- **Gamepads** work as soon as you press one of their buttons: the first is player 1, the second player 2. Standard pads are laid out as a DualShock, sticks and stick clicks included. Pads without a standard mapping work through their main axes or a hat switch.
- **On-screen controller**: a D-pad you can slide around on, Select and Start, the four face buttons and the shoulder buttons, for player 1 or player 2. It is shown on touch screens, and works with a mouse too.

## Console

The toolbar has pause, the console's Reset button, power cycle and full screen, and what is plugged into the controller ports:

- **Digital pad** or **DualShock**, for each port. A DualShock starts in digital mode, as the real one does; games that use the sticks switch it to analog themselves, and **Analog** (player 1's Analog button) switches it by hand for the others. Games that vibrate the DualShock (Crash Bandicoot: Warped, Metal Gear Solid and so on) rumble your gamepad, in browsers that support it (Chrome and Edge).

Save states keep the whole console in the browser, except the disc: a state remembers which disc it was made with (by its serial) and asks for that disc to be put in before it is loaded. States of programs dropped as an `.exe` carry the program. They can be exported and imported as `.psxstate` files.

A status line shows what's in and how fast it runs: on a computer too slow to keep up, it says what share of full speed the console is managing.

## Discs

Drop the `.cue` sheet and all the `.bin` files it names together (choose them together in **Choose files...**), a `.chd` (MAME's compressed disc format, as made by `chdman createcd`), a `.pbp` (a PSP `EBOOT.PBP`, as made by popstation or pop-fe), or a single `.bin` (2352-byte sectors) or `.iso` (2048-byte sectors) image. The files are read from your disk as the game asks for them, never copied into the browser, so even a 700 MB disc starts at once. Multi-track discs play their CD audio tracks. For multi-disc games, dropping the next disc of the game that is running (or choosing it with **Swap disc...**) changes discs without restarting: the lid opens for a second and closes on the new disc, as the game expects. CHDs compressed with Zstandard (`chdman createcd -c cdzs`) aren't supported: recompress them with the default codecs. A multi-disc PBP starts on disc 1; drop the same PBP again while it's running to go on to the next disc. PBPs from the PlayStation Store are encrypted and can't be read: convert them to CUE/BIN first.

PAL games run at 50 Hz and NTSC games at 60 Hz, as the game asks the GPU for. The CD-ROM reports the disc's region (from its serial or licence text) to the game.

No commercial games are included in this repository. Use images of discs you own. `npm run fetch:games` downloads the freely licensed homebrew listed in `scripts/games-catalog.json` (each with its credit, licence, source and checksum) into `public/games/`, where it appears in a "Free games" picker. To offer other games, list them in `public/games/index.json` the same way: `{ "games": [{ "title": "Some Game", "file": "some-game.bin" }] }`.

## BIOS

OpenBIOS (MIT licensed) boots many games, and does almost all the retail BIOS does except show Sony's intro. Some games need the real BIOS: if one doesn't start, **Add BIOS...** (or drop a 512K file with "bios" or "scph" in its name) keeps your own console's BIOS in the browser, and **Use my BIOS** switches between it and OpenBIOS. **Forget** removes it. **Skip BIOS intro** starts discs straight away, without the logos (about 10 seconds sooner with Sony's BIOS, 5 with OpenBIOS); it takes effect the next time the console starts. Known dumps are named by console model (SCPH-1001 and so on), and a known damaged dump of the SCPH-5502 is refused (it crashes before the Sony logo). Put BIOS images in `roms/bios/` (never committed) and `npm test` boots each to its menu.

## Memory cards

Two memory cards are always in, and belong to the console like real ones: every game saves to the same two, and they are kept in the browser as the game writes them. **Download .mcr** gives a card as a raw 128K image, the format most emulators use; **Load card...** (or dropping a `.mcr`, `.mcd`, `.gme` or `.mem` file) puts a card image in. A new card is formatted.

## Compatibility

Tested so far, booting through OpenBIOS:

- Tetrade (homebrew, from its disc).
- Crash Bandicoot: Warped (NTSC-U): intro, title, cutscenes.
- Tekken (PAL): the Galaga loading game, intro video with XA audio, fights with CD audio music.
- Final Fantasy VII (PAL, German): opening credits video, title menu, memory card screens, New Game through the opening into the first Midgar scene with music.
- Metal Gear Solid (PAL): to the title screen with music.
- Ridge Racer (PAL, CD audio tracks): to the start of a race.
- Resident Evil (PAL): intro video.
- Castlevania: Symphony of the Night (PAL): intro video with audio.
- Gran Turismo (PAL): 640×480 title menu and car menus.
- Spyro the Dragon (PAL): intro.

They run at full speed in Chrome with headroom to spare: in Node the heaviest (Final Fantasy VII's field scenes, Metal Gear Solid, Gran Turismo) emulate 105-115 frames a second, twice what PAL needs. Fourteen retail BIOSes (Japanese, American and European, SCPH-1000 to SCPH-7502 and the PS one's SCPH-101) show the Sony logo and reach their menu, and boot these games through the PlayStation logo.

What isn't there yet: the multitap, light guns and mice, and the PocketStation. The CD-ROM's timings are averages rather than the drive's exact seek times. There's no recompiler: the interpreter keeps up without one.

## Accuracy

`npm run fetch:tests` downloads [JaCzekanski's ps1-tests](https://github.com/JaCzekanski/ps1-tests), which come with logs and VRAM screenshots from a real console; `npm test` runs them through OpenBIOS:

- CPU coprocessor and I/O access tests, DMA (OTC and DPCR), and timer rates match the console.
- GTE: all 1,150 tests pass.
- GPU: quads, rectangles, transparency, texture flipping, clipping, texture overflow and VRAM copies match the console's VRAM pixel for pixel; triangles, lines and the colour table cache match within 0.5% of pixels (the rest a colour step away).
- MDEC: monochrome blocks match exactly; colour frames match 97% of pixels exactly and the rest within one step.

## Development

```sh
npm install
npm run fetch:bios        # OpenBIOS into public/bios/ (needed to run anything)
npm run fetch:games       # optional: free games into public/games/
npm run fetch:tests       # optional: ps1-tests into tests/fixtures/, run by npm test
npm run dev               # http://localhost:5173
npm test                  # tests needing downloaded files skip when they're missing
npm run bench -- game.cue # emulated frames per second, in Node
```

`npm test` also boots any disc in `roms/` (your own; never committed) to its first pictures.

## Deploying

`.github/workflows/pages.yml` downloads OpenBIOS, the free games and the ps1-tests, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
