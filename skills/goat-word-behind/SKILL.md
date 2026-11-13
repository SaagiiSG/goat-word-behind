---
name: goat-word-behind
description: Word Behind Head · Толгойн ард үг. Edits a talking-head video so a giant silver Mongolian word stands behind the speaker's head (the head covers part of it), with a glowing teal line or a turning teal ring behind them, teal chips for listed items and plain white captions. Uses a person cut-out on every frame. Renders a 1080x1920 MP4 for Reels/TikTok. Best for barbers, beauty and salons, auto, and coaches who are strong on camera. Use whenever the user wants a word or title behind their head, "толгойн ард үг", "толгойн ард бичиг", "үгийг ардаа гаргаж өг", "text behind me", "word behind head", or types /goat-word-behind, even if they don't name the skill.
---

# Word Behind Head · Толгойн ард үг

The speaker fills the screen. A huge silver word stands in the top third, behind their head, so their hair or hat cuts into it. A glowing teal line drifts behind them, or a teal ring with tick marks turns around their head. Small teal "app" chips pop in for each thing they list, and plain white captions sit mid-frame. It is the only GOAT look where the type sits between the background and the person.

**Good for:** barbers, beauty and salons, auto, coaches who are strong on camera. One person talking to the phone.
**Not for:** footage with no person in it, two or more people, and busy backgrounds (crowds, shelves, leaves, neon signs) that the cut-out can't separate from the person. If the footage is like that, say so and suggest another GOAT look.

Talk to the user in the language they write in (usually Mongolian). Keep messages short and plain; many users are not technical. `SKILL_DIR` means this skill's base directory (shown when the skill loads). Run commands from the user's project folder with absolute paths into `SKILL_DIR`.

## 1. Setup check (first time on a machine)

Run `ffmpeg -version` and `uv --version`. If either is missing, show the install command and ask before installing (it is their computer):
- Mac: `brew install ffmpeg uv`
- Windows: `winget install Gyan.FFmpeg` and `winget install astral-sh.uv`, then close and reopen the terminal.

The first render downloads Pillow, numpy and MediaPipe (the person cut-out, about 120 MB) once. Tell the user it takes a few minutes the first time. After that it starts at once.

**Computers:** a Mac with Apple silicon (M1 or newer, macOS 13 or newer) or 64-bit Windows 10/11. Intel Macs can't run it: MediaPipe stopped making builds for them in 2023. Windows has not been tested yet, so if the render fails there, show the error to the user and suggest a look without a cut-out (for example goat-slam-words).

## 2. Collect the clips and words

Make `raw/` and `output/` in the current folder. Ask for:
1. **The clips:** the user talking to the phone camera. Drag them into the chat or copy them into `raw/`.
2. **The words:** one big word per topic (e.g. "ЭНГИЙН", "ӨНӨӨДӨР", "ХЯМДРАЛ"), what they say (for captions), and any list items for chips (e.g. "Үс засалт", "Сахал засалт"). Never invent a price, phone number or date. Ask.

**What to film** (tell the user before they shoot, if they haven't yet):
- Film with your head in the upper half of the frame so captions don't cover your face. Phone upright, the top of the head about a quarter of the way down the screen. The word goes above the head and the captions sit on the chest.
- A plain background that contrasts with hair and clothes (dark hair against a light wall, or a light top against a dark room). The cut-out finds the person by contrast. A darker room makes the silver word shine most.
- One person, good light on the face, no one walking behind.

If this folder was already edited with `goat-video-editor`, use `output/cut.mp4` as the clip and `transcript/cut_words.json` for word times.

Then run: `uv run SKILL_DIR/scripts/goatcut.py probe raw/*`
It prints each file's size, length, whether it has sound, whether it is HDR, and `speech` spans (when someone is talking). Use these to time the words.

## 3. Write plan.json

Write `plan.json` in the project folder. Paths are relative to it.

```json
{
  "output": "output/word-behind.mp4",
  "clips": [
    {"src": "raw/IMG_0412.MOV", "in": 0.5, "out": 9.5},
    {"src": "raw/IMG_0413.MOV", "in": 0.0, "out": 7.0}
  ],
  "texts": [
    {"role": "word", "text": "Энгийн", "start": 0.3, "end": 3.2},
    {"role": "caption", "text": "Энгийн зүйлсээс эхэлье", "start": 0.4, "end": 3.2},
    {"role": "chip", "text": "Үс засалт", "start": 1.0, "end": 3.2},
    {"role": "chip", "text": "Сахал засалт", "start": 1.6, "end": 3.2},
    {"role": "word", "text": "Өнөөдөр", "start": 3.4, "end": 6.5},
    {"role": "caption", "text": "Өнөөдөр л эхэл", "start": 3.5, "end": 6.5}
  ],
  "look": {"dim": 0.4}
}
```

**clips** play in order. `in`/`out` trim a video (seconds). Add `"sound": false` to mute one clip. `cx`/`cy` (0–1, default 0.5) choose which part of a wider frame is kept.
**texts:**
- `word`: the giant silver word behind the head, in capitals (typed in any case). One at a time. It is placed when it appears so the top of the head covers its lower third, and it stays there. The 1st, 3rd, 5th... word gets the teal line drifting behind the head; the 2nd, 4th... gets the turning teal ring around the head. Long words shrink to fit; one word reads best.
- `caption`: plain white capitals mid-frame, in front of the speaker. One at a time.
- `chip`: a teal icon with a short label, stacked under the caption, in front of the speaker. Up to 3 show at once (the newest 3). Keep labels to 1–3 words.
**look** options:
- `dim`: how much the background behind the speaker darkens, from `0` (as filmed) to `0.8`. Default `0.4`. Raise it to `0.6` on a bright wall so the word stands out; the speaker is never darkened.

**Auto sound effects:** a soft whoosh as each word rises behind the head, a light pop as each chip appears.

**Timing:** change the word with each new topic, every 2–4 s. Start a word a moment before the speaker says it. Chips should appear as each item is said.

Before rendering, tell the user the plan in plain words (the clips, each word with its time, the captions and chips) and ask "OK?". This is the only approval needed.

<!-- audio: this section is copied from core/skill-audio.md by build.py; edit it there -->
## Sound effects, voice-over and music

**Sound effects are on by default.** The look adds its own (see "Auto sound effects" above). They are made in code, so there's nothing to license, and they sit quietly under the voice.
- Turn them off: `"sfx": false`. Make them quieter or louder: `"sfx": {"volume": 0.6}`.
- Add one: `"sfx": {"add": [{"sound": "ding", "at": 4.2}]}`. Sounds: whoosh, swish, pop, click, type, shutter, boom, thud, hit, riser, ding, notify, shimmer, paper, tape, marker, projector, tick. `type`, `marker`, `projector` and `riser` also take `"dur"` in seconds; a riser should end on the moment it builds to.
- Let the user hear one render before adding more. Too many sounds feel cheap.

**Voice-over.** If the user wants to talk over the video, ask them to record it on their phone (a voice memo is fine: m4a, mp3 or wav) and copy it into `raw/`. Then add `"voiceover": {"src": "raw/vo.m4a", "at": 0.5}` (`at` = when it starts; optional `"volume"`). While the voice plays, the clips' own sound and the music dip automatically. Run `goatcut.py probe raw/vo.m4a` to get its `speech` spans and time the words on screen to them. The clips must add up to at least the voice-over's length (the render warns if not). Recording tips for the user: a small quiet room (a parked car or a wardrobe works), phone about 20 cm from the mouth, read the script out loud once before recording.

**Music.** `"music": {"src": "raw/song.mp3", "volume": 0.25}`. Only use music the user has the rights to. Music added inside the Instagram/TikTok app is the safe choice, so suggest that first.
<!-- /audio -->

## 4. Render and check

`uv run SKILL_DIR/scripts/render.py plan.json`

The cut-out runs on every frame, so it takes about 2–3 times the video length on an M1-or-newer Mac (a 30 s video in about 1–1.5 min), longer if the computer is busy. Then look at three frames before saying it is done:
`ffmpeg -y -loglevel error -ss 2 -i output/word-behind.mp4 -frames:v 1 output/check-1.jpg` (and two more times, one per word). Read them. Check that:
- the word is readable: the head covers part of it, not most of it. If the head hides too much, shorten the word;
- the cut-out edge follows the hair and shoulders, and nothing from the background (a sign, a lamp) sits in front of the word. If it does, the background is too busy: raise `dim` or suggest refilming against a plainer wall;
- captions and chips don't cover the face (if they do, the head was filmed too low; say so).

If a render fails twice, stop and explain the error in plain words. Don't loop.

## 5. Hand over

Tell the user where the file is (`output/word-behind.mp4`) and that it is ready to post. Music can be added in the Instagram/TikTok app.

## Rules

- A price, phone number or offer goes in a `caption` or `chip`, which sit inside the area no app buttons cover. Never put it in the `word`.
- Use only the fonts bundled in `SKILL_DIR/fonts` (they have Ө ө Ү ү). Don't swap in other fonts.
- Captions stay plain white with no pop or bounce.
- The cut-out model (`SKILL_DIR/models/selfie_segmenter.tflite`, Google MediaPipe, Apache-2.0) is bundled; nothing is uploaded anywhere.
- The output is 1080x1920, 30 fps, H.264, sound normalised to -14 LUFS (Instagram/TikTok level).
