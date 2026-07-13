# Theming `@ancientpantheon/khronoton-core/ui`

The UI is styled entirely through CSS custom properties — no Tailwind, no utility classes ship. There is exactly one themeable surface: the `--khr-*` token block.

## Setup

```ts
import "@ancientpantheon/khronoton-core/ui.css";        // the token base (once)
import { KhronotonUiRoot } from "@ancientpantheon/khronoton-core/ui";

<KhronotonUiRoot>{/* Khronoton UI */}</KhronotonUiRoot>
```

`ui.css` declares the base palette on `:root, .khronoton-ui`. `<KhronotonUiRoot>` applies the `.khronoton-ui` scope class; every component references `var(--khr-*)` inline.

## Recolor (add your own colors on top)

Override any subset of tokens at **`body .khronoton-ui`** — its specificity `(0,1,1)` beats the package's `.khronoton-ui` `(0,1,0)` **regardless of stylesheet load order**. Unlisted tokens stay inherited.

```css
body .khronoton-ui {
  --khr-bg: #0d0a07;
  --khr-panel: #120f0b;
  --khr-accent: #d4a04a;
  --khr-accent-tint: #241c10;
}
```

## Tokens

Surfaces `--khr-bg` `--khr-panel` `--khr-inset` `--khr-border` · text `--khr-text` `--khr-text-dim` `--khr-text-dim2` `--khr-mono` · accent `--khr-accent` `--khr-accent-tint` · status pairs `--khr-{blue,amber,success,error,nothing}` + their `-bg` · `--khr-radius` `--khr-radius-lg` · `--khr-font` `--khr-mono-font`.
