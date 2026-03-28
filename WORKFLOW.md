# PocketTTS — Architecture & Workflow

## Design: Single Global Buffer → Flat Queue

```
chat[mes].mes (streaming text)
    ↓ timer (250ms)
processNewText() — appends new chars to adp.textBuffer
    ↓ sentence split
adpGenerateAndPlay(msgId, sentence) — placeholder to adp.tracks[]
    ↓ WS queue (sequential, FIFO)
Server generates audio per request
    ↓ response
placeholder.url filled, pending=false
    ↓ playNextInQueue()
Audio plays in tracks[] order
```

## Key Principles

1. **One text buffer** (`adp.textBuffer`) — all streaming text appends here, regardless of message
2. **One flat queue** (`adp.tracks[]`) — tracks ordered by text arrival, tagged with `msgId`
3. **Sequential WS** — one request at a time, guarantees audio order = text order
4. **Album UI** — `getPlaylistView()` groups tracks by `msgId` for display

## State

```javascript
adp = {
    tracks: [],          // [{url, duration, text, msgId, pending, error}]
    playingIdx: -1,      // index into tracks[] of currently playing (-1 = none)
    playingTrack: null,  // text of track currently playing
    isPlaying: false,
    timer: null,
    active: false,
    textBuffer: '',      // global text buffer
    lastMsgId: null,     // current message being streamed
    lastTextLen: 0,      // how much of chat[mes].mes already read
}
```

## Scenario: 3 messages, 10s audio per sentence

### Text streaming: 2.5x speed (10s audio = 4s text)

```
T=0     Msg1 starts. Timer starts reading.
T=4     Msg1 sentence 1 complete → track #0 pushed
T=4-6.5 Server generates audio for #0
T=6.5   Audio ready. playNextInQueue → S1 plays
T=8     Msg1 sentence 2 → track #1 pushed
T=10.5  Audio ready for #1
T=12    Msg1 sentence 3 → track #2 pushed
T=14.5  Audio ready for #2
T=15    Msg2 starts. Old text flushed. New text appended to same buffer.
T=16.5  S1 ends → S2 plays
T=19    Msg2 sentence 1 → track #3 pushed
T=21.5  Audio ready for #3
T=23    Msg2 sentence 2 → track #4 pushed
T=24    Msg3 starts. Old text flushed. New text appended.
T=25.5  Audio ready for #4
T=26.5  S2 ends → S3 plays
T=27    Msg2 sentence 3 → track #5 pushed
T=29.5  Audio ready for #5
T=31    Msg2 sentence 4 → track #6 pushed
T=33.5  Audio ready for #6
T=36.5  S3 ends → S4 plays (track #3)
T=46.5  S4 ends → S5 plays (track #4)
...continues in track order
```

### tracks[] at T=24:
```
#0  msg=1  S1  ○ ready     "Flara's eyes flash..."
#1  msg=1  S2  ○ ready     "She leans in close..."
#2  msg=1  S3  ○ ready     "He watches her..."
#3  msg=2  S4  ○ ready     "`He's broken..."
#4  msg=2  S5  ◌ pending   "The gold I sense..."
```

### Playlist panel at T=24:
```
#1 (3 tracks)
  ▶ "Flara's eyes flash..." (playing)
  ○ "She leans in close..."
  ○ "He watches her..."

#2 (2 tracks)
  ○ "`He's broken..."
  ◌ "The gold I sense..."
```

## Swipe Behavior

- `nukeMsgTracks(msgId)` removes ALL tracks for that message from `adp.tracks[]`
- Remaining tracks shift to fill the gap
- `playingIdx` recalculated if the playing track was from that message
- New generation starts fresh with empty `textBuffer`

## Error Handling

- WS request fails after 3 retries → track marked `error: "reason"`
- `playNextInQueue` skips error tracks (shifts `playingIdx`)
- Error tracks shown with `✕` strikethrough in playlist panel
- Total fail time: ~3.75s per track (not 120s timeout)

## Known Limitations

1. **Orphaned tracks on swipe**: Tracks already in `adp.tracks[]` for other messages aren't cancelled. They complete and fill their URLs, but are no longer needed. Mitigated by fast generation (2.5s).
2. **No per-message cancel**: Can't cancel WS requests for just one message. `nukeMsgTracks` removes from display, but in-flight requests complete anyway.
3. **Buffer semantics**: `textBuffer` accumulates ALL text. On new message, old buffer is flushed before new text starts. This ensures no text is lost between messages.
