# Pieces

`white/` and `black/` are intentionally empty.

Phase 1 renders pieces with Unicode chess glyphs. The **solid** glyph set
(`♚♛♜♝♞♟`) is used for both colours and recoloured in CSS, so:

- both sides have identical shapes on every platform
- pieces stay sharp at any pixel density (they are font vectors)
- there are no image requests and nothing to preload

## Swapping in SVG or PNG pieces

There is exactly one place to change — `renderPieceContent()` in
`js/board.js`:

```js
function renderPieceContent(pieceEl, piece) {
  pieceEl.textContent = PIECE_GLYPHS[piece.type] ?? '';
}
```

Replace it with, for example:

```js
function renderPieceContent(pieceEl, piece) {
  const folder = piece.color === 'w' ? 'white' : 'black';
  pieceEl.textContent = '';
  const img = document.createElement('img');
  img.src = `./assets/pieces/${folder}/${piece.type}.svg`;
  img.alt = '';
  img.draggable = false;
  // Missing artwork falls back to the glyph rather than showing a broken image.
  img.onerror = () => { pieceEl.textContent = PIECE_GLYPHS[piece.type] ?? ''; };
  pieceEl.append(img);
}
```

Expected filenames in each folder: `k.svg`, `q.svg`, `r.svg`, `b.svg`,
`n.svg`, `p.svg`.

You will also want to drop the glyph outline styling for `.piece[data-color]`
in `css/board.css`, and give `.piece img` a `width: 100%`.

Good open-licence sources include the Cburnett set (CC BY-SA) and Lichess'
piece sets — check each set's licence before shipping.
