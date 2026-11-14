---
name: goat-word-behind
description: Word Behind Head · Толгойн ард үг. Edits a talking-head video so a giant silver Mongolian word stands behind the speaker's head (the head covers part of it), with a glowing teal line or a turning teal ring behind them, teal chips for listed items and plain white captions made from what they say. Cuts the pauses out, cuts the person out on every frame. Renders a 1080x1920 MP4 for Reels/TikTok. Best for barbers, beauty and salons, auto, and coaches who are strong on camera. Use whenever the user wants a word or title behind their head, "толгойн ард үг", "толгойн ард бичиг", "үгийг ардаа гаргаж өг", "text behind me", "word behind head", or types /goat-word-behind, even if they don't name the skill.
---

# Word Behind Head · Толгойн ард үг

The speaker fills the screen. A huge silver word stands in the top third, behind their head, so their hair or hat cuts into it. A glowing teal line drifts behind them, or a teal ring with tick marks turns around their head. Teal "app" chips pop in for each thing they list, and plain white captions of their own words sit under the face. Pauses are cut out so it moves fast. It is the only GOAT look where the type sits between the background and the person.

**Good for:** barbers, beauty and salons, auto, coaches who are strong on camera. One person talking to the phone.
**Not for:** footage with no person in it, two or more people, and busy backgrounds (crowds, shelves, leaves, neon signs) that the cut-out can't separate from the person. If the footage is like that, say so and suggest another GOAT look.

Talk to the user in the language they write in (usually Mongolian). Keep messages short and plain; many users are not technical. `SKILL_DIR` means this skill's base directory (shown when the skill loads). Run commands from the user's project folder with absolute paths into `SKILL_DIR`. `goat` below means `node SKILL_DIR/scripts/goat.mjs`.

## 1. Setup check (first time on a machine)

Run `node --version` (needs 22 or newer) and `ffmpeg -version`. If either is missing, show the install command and ask before installing (it is their computer):
- Mac: `brew install node ffmpeg whisper-cpp` (whisper-cpp makes the captions; Homebrew's build uses the Mac's graphics chip, so it is fast).
- Windows: `winget install OpenJS.NodeJS.LTS` and `winget install Gyan.FFmpeg`, then close and reopen the terminal. For captions, download `whisper-bin-x64.zip` from https://github.com/ggml-org/whisper.cpp/releases, unzip it, and set `HYPERFRAMES_WHISPER_PATH` to the `whisper-cli.exe` inside (`setx HYPERFRAMES_WHISPER_PATH "C:\path\to\whisper-cli.exe"`, then reopen the terminal). Without it the captions step tries to build Whisper and needs developer tools.

The first video downloads, once: the speech model (Whisper large-v3, about 3 GB), the cut-out model (168 MB), and a private copy of Chrome that draws the frames. Tell the user the first run takes a while; after that it starts at once. Nothing is uploaded: everything runs on their computer, with no account.

**Long steps:** the first `transcribe` (the 3 GB download, then about 3 min per 6–7 s of speech on an 8 GB Mac) and every `render` can run longer than a normal command timeout. Run them in the background, or with a 600000 ms timeout, and wait for them to end. Never stop one and start it again: an interrupted download starts again from zero. Whisper needs about 4 GB of memory, so ask the user to close other heavy apps first on an 8 GB computer.

**Windows has not been tested yet.** If a step fails there, show the error to the user in plain words and suggest a look without a cut-out (for example goat-slam-words).

## 2. Collect the clips

Make `raw/` and `output/` in the current folder. Ask for the clips: the user talking to the phone camera. Drag them into the chat or copy them into `raw/`.

**What to film** (tell the user before they shoot, if they haven't yet):
- Phone upright, filmed from the chest up, the top of the head about a quarter of the way down the screen. The word goes above the head and the captions sit under the face. A close-up where the face fills the screen leaves no room for them.
- A plain background that contrasts with hair and clothes (dark hair against a light wall, or a light top against a dark room). The cut-out finds the person by contrast. A darker room makes the silver word shine most.
- One person, good light on the face, no one walking behind. Speak clearly; the captions come from the speech.

Then run `goat probe raw/*`. It prints each file's size, length, whether it has sound, whether it is HDR, and `speech` spans (when someone is talking).

## 3. Prepare, transcribe, cut

Write `plan.json` in the project folder with just the clips for now (paths are relative to it):

```json
{
  "output": "output/word-behind.mp4",
  "clips": [
    {"src": "raw/IMG_0412.MOV", "in": 0.5, "out": 9.5},
    {"src": "raw/IMG_0413.MOV"}
  ]
}
```

`in`/`out` trim a video (seconds). Add `"sound": false` to mute one clip. `cx`/`cy` (0–1, default 0.5) choose which part of a wider frame is kept.

Then run these in order. Each one says what to run first if a step is missing.
1. `goat prep plan.json`: joins the clips into one upright 1080x1920 video.
2. `goat transcribe plan.json`: writes what the speaker says, word by word with times, to `.work-word-behind/transcript.json`, and prints it as caption lines.
3. **Fix the words.** Whisper gets many Mongolian words wrong. Fix obvious spelling yourself, then show the user the caption lines and ask them to correct anything wrong. Change only the `text` of each word in `transcript.json`; keep `start` and `end`. If two words came out as one, split the time between them; if one word came out as two, give the merged word the first one's `start` and the second one's `end`. If Whisper missed words the user did say, add them with times between their neighbours. Never add words they didn't say. If the transcript is junk (music, no speech), write `[]` into `transcript.json`: captions and pause cutting turn off.
4. `goat cut plan.json`: cuts the pauses down to a short breath and moves the word times to match. It prints the old and new length. It only cuts where it also hears quiet, never cuts photos or clips without sound, and stops with a message if it would cut more than 60% of the video. Add `"cut": false` to plan.json if the user doesn't want pauses cut. **If the words are fixed after this step, run `cut` again** (it is quick: the video is reused when the cuts don't change); `render` refuses to run on an old cut.

Then read `.work-word-behind/words.json` (the words with their times after the cut) to time the big words and chips.

## 4. Write the words

Add `texts` and `look` to plan.json. Times are in the cut video (from `words.json`):

```json
  "texts": [
    {"role": "word", "text": "Энгийн", "start": 0.2, "end": 3.2},
    {"role": "chip", "text": "Үс засалт", "start": 1.0, "end": 3.2},
    {"role": "chip", "text": "Сахал засалт", "start": 1.8, "end": 3.2},
    {"role": "word", "text": "Өнөөдөр", "start": 3.4, "end": 6.4}
  ],
  "look": {"dim": 0.4}
```

**texts:**
- `word`: the giant silver word behind the head, shown in capitals (type it in any case). One at a time. It is placed so the top of the head covers its lower part. Long words shrink to fit; one short word reads best. Pick the key word of each topic and change it every 2–4 s, a moment before the speaker says it.
- `chip`: a teal icon with a short label (1–3 words), stacked under the captions. Start each one as the item is said; they all leave at their `end`. **At most 2 chips on screen at once**: a third sits below the safe area. If the render prints a note naming a chip or the captions, the app's own text may cover them; tell the user.
- Captions are made from `words.json` automatically: plain white capitals, 2–4 words at a time, no animation. Add `"captions": false` to turn them off.

**look** options:
- `dim`: how much the background behind the speaker darkens, from `0` (as filmed) to `0.8`. Default `0.4`. Raise it to `0.6` on a bright wall so the word stands out; the speaker is never darkened.
- `deco`: what moves behind the head: `"auto"` (default: the 1st, 3rd… word gets the teal line, the 2nd, 4th… the turning ring), `"line"`, `"ring"` or `"none"`.

**Auto sound effects:** a soft whoosh as each word rises, a shimmer as a ring draws on, a light pop as each chip appears.

Before rendering, tell the user the plan in plain words (each big word with its time, the chips) and ask "OK?". This is the only approval needed.

<!-- audio: this section is copied from core/skill-audio-node.md by build.py; edit it there -->
## Sound effects, voice-over and music

**Sound effects are on by default.** The look adds its own (see "Auto sound effects" above). They are made in code, so there's nothing to license, and they sit quietly under the voice.
- Turn them off: `"sfx": false`. Make them quieter or louder: `"sfx": {"volume": 0.6}`.
- Add one: `"sfx": {"add": [{"sound": "ding", "at": 4.2}]}`. Sounds: whoosh, swish, pop, click, type, shutter, boom, thud, hit, riser, ding, notify, shimmer, paper, tape, marker, projector, tick. `type`, `marker`, `projector` and `riser` also take `"dur"` in seconds; a riser should end on the moment it builds to.
- Let the user hear one render before adding more. Too many sounds feel cheap.

**Voice-over.** If the user wants to talk over the video, ask them to record it on their phone (a voice memo is fine: m4a, mp3 or wav) and copy it into `raw/`. Then add `"voiceover": {"src": "raw/vo.m4a", "at": 0.5}` (`at` = when it starts; optional `"volume"`). While the voice plays, the clips' own sound and the music dip automatically. Run `node SKILL_DIR/scripts/goat.mjs probe raw/vo.m4a` to get its `speech` spans and time the words on screen to them. The clips must add up to at least the voice-over's length (the render warns if not). Recording tips for the user: a small quiet room (a parked car or a wardrobe works), phone about 20 cm from the mouth, read the script out loud once before recording.

**Music.** `"music": {"src": "raw/song.mp3", "volume": 0.25}`. Only use music the user has the rights to. Music added inside the Instagram/TikTok app is the safe choice, so suggest that first.
<!-- /audio -->

## 5. Render and check

`goat render plan.json`

It cuts the person out of every frame, draws the look, mixes the sound and writes the MP4 plus a contact sheet (one frame per second) at `.work-word-behind/sheet.jpg`. On our test Mac a 6.5 s clip took about 1.5 min: about 1 min to cut the person out, then about 25 s to draw. Longer videos take longer, and more if the computer is busy. Run the next render only after the last one ends. Read the contact sheet and one full-size frame per big word before saying it is done:
`ffmpeg -y -loglevel error -ss 2 -i output/word-behind.mp4 -frames:v 1 output/check-1.jpg`
Check that:
- the word is readable: the head covers part of it, not most of it. If the head hides too much, shorten the word;
- the cut-out edge follows the hair and shoulders, with no coloured fringe, and nothing from the background (a sign, a lamp) sits in front of the word. If it does, the background is too busy: raise `dim` or suggest refilming against a plainer wall;
- captions and chips don't cover the face or mouth. If they do, the face fills too much of the screen: say so and suggest filming from further away.

If a render fails twice, stop and explain the error in plain words. Don't loop.

## 6. Hand over

Tell the user where the file is (`output/word-behind.mp4`) and that it is ready to post. Music can be added in the Instagram/TikTok app.

## Rules

- A price, phone number or offer goes in the first `chip` of a topic (the highest one), never in the `word`. If the render's note names that chip, it sits where app text can cover it: say so and suggest filming from the chest up. Never invent a price, number or date; ask.
- Use only the fonts bundled in `SKILL_DIR/fonts` (they have Ө ө Ү ү). Don't swap in other fonts.
- Captions stay plain white with no highlight, pop or bounce.
- The speech model, cut-out model and Chrome run on the user's computer. Nothing is uploaded.
- The output is 1080x1920, 30 fps, H.264, sound normalised to -14 LUFS (Instagram/TikTok level).
