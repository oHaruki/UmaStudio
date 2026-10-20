# UmaStudio

Pose Uma Musume characters, give them props and backgrounds, and save PNGs or videos.

UmaStudio reads the files of your installed game (Steam version). The game can stay closed,
nothing in the game folder is changed, and nothing is sent anywhere: the app runs on your PC only.

![UmaStudio](docs/screenshot.jpg)

Website and guide: https://umastudio.byharuki.dev

## Download

1. Get `UmaStudio-<version>.zip` from [Releases](https://github.com/oHaruki/UmaStudio/releases/latest).
2. Extract it anywhere and run `UmaStudio.exe`.

You need:

- Windows 10 or 11
- Uma Musume installed through Steam, started at least once so its data is downloaded
- For video export only: [ffmpeg](https://ffmpeg.org/download.html), either on PATH or `ffmpeg.exe` next to `UmaStudio.exe`

The first start takes a bit while it reads the game's file list. Every character is converted
the first time you open her, after that she loads from the cache.

## How to use it

- **Choose an Uma** (top left), then the outfit next to it. The picker has three tabs: the main
  Umas, their **Chibi** versions, and the **Background Umas** from races and events.
- **Poses** (left): pick a category, search in plain English ("arms crossed", "waving", "phone").
  A pose with several parts shows buttons for them (start, loop, end, still). Pause anywhere on the
  timeline and that frame is your pose. Chibis have their own category.
- **Face**: expressions, single face parts, and "Look at camera".
- **Pose**: show the joints, click one and turn it with the rings. Changes sit on top of the
  motion, so pictures, videos and exports keep them. Poses can be saved and loaded.
- **Props**: one of the game's hand props, or your own picture as a card or a box. A picture can
  also go on a game prop. Drag the handles in the view to place it.
- **Render**: lens, background (transparent, color, a game background, your own picture, or a
  3D **Place**: concert stages, racecourses, Tracen, story, cut-in and gacha sets, with season,
  weather and time of day where the game has them), PNG size (presets or your own), video (MP4, transparent WebM, MOV for editing, transparent GIF,
  or numbered PNG frames), and **Export for Blender**: her mesh, skeleton, textures and props as
  a .glb, in the current pose or with the motion baked in.
- **Look**: light, shadow size, outlines, hair and cloth physics with body collisions.

**Edit the place** (under Place) lets you move, turn, resize or hide its parts, from a list or by
clicking them in the view, and stand her somewhere else on it. Changes are kept per place.

Mouse: left drag turns the camera, right drag pans, wheel zooms.
Keys: Space plays/pauses, W / E / R switch the prop handles, Delete removes a prop, Esc lets go,
Ctrl+Z undoes a joint change.

## Where files go

| What | Where |
| --- | --- |
| Saved PNGs and videos | `Pictures\UmaStudio\renders` |
| Your pictures (for props and backgrounds) | `Pictures\UmaStudio\images` |
| Converted characters, props, backgrounds | `Pictures\UmaStudio\viewer-cache` |
| Game file list cache, log | `%LOCALAPPDATA%\UmaStudio` |

Deleting `viewer-cache` is safe, things are converted again when needed.

## Run from source

Python 3.12:

```
cd viewer
pip install -r requirements.txt
python serve.py
```

It opens http://127.0.0.1:27620 in your browser. `viewer\build_exe.ps1` builds
`viewer\dist\UmaStudio\UmaStudio.exe` in its own venv.

## Help

- Discord: https://discord.gg/f4QZNag9Hv
- Support the project: https://ko-fi.com/harukidev

## Notes

UmaStudio is a fan project and not affiliated with Cygames. It ships no game files: everything
it shows comes from your own install. Characters and art belong to their owners.

Licensed under GPL-3.0 (see [LICENSE](LICENSE)). Bundles [three.js](https://threejs.org) (MIT, `viewer/static/vendor/three-LICENSE.txt`).
