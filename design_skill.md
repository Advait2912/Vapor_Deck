# Vapor Deck: High-End Presentation Design

This skill guides the creation of distinctive, production-grade slide decks that avoid generic "AI slop" aesthetics. You are not just picking colors; you are crafting a visual language that communicates a specific emotional and intellectual atmosphere.

## Design Thinking & Methodology

Before generating a design configuration, perform deep visual analysis:

- **Atmospheric Feel**: Define the emotional resonance. Is it cold, clinical, and precise? Or warm, organic, and nostalgic? Use evocative descriptors (e.g., "Post-Human Neoclassical", "Desert-Bloom Brutalism", "VHS Glitch-Core Minimalism").
- **Color Theory**: Don't just pick a palette. Define the *relationship* between colors. Use primary backgrounds with high-contrast accent bursts. Think about "Key", "Fill", and "Rim" light colors in CSS. Use secondary tones for depth and tertiary tones for micro-details.
- **Typography as Architecture**: Fonts are not just text; they are structural elements. Pair a loud, characterful display face for headlines with a clean, highly legible grotesque or serif for body text. Use mono fonts for technical annotations to add a layer of precision.
- **Component DNA**: Define how elements like buttons, cards, and dividers behave. Are they glassmorphic with blurred backgrounds? Solid and sharp with 0px radius? Outlined with hairline borders? High-shadow depth or flat and sticker-like?
- **Visual Elements**: Decide on recurring motifs—gradients, grain, scanlines, noise, organic blobs, isometric grids, or architectural wireframes.

## Execution Guidelines

- **Typography**: Go beyond the basics. If you want "Cyberpunk", don't just use a sans-serif—choose something like "Space Grotesk" or "JetBrains Mono" paired with a high-contrast serif.
- **Composition**: Use asymmetrical grids, generous negative space, and overlapping elements to create a sense of professional editorial design (magazine-style).
- **Motion & Depth**: Think about how elements enter. Staggered reveals, subtle parallax, and depth-of-field effects (blur) should be hinted at in your layout preferences.

**CRITICAL**: Avoid "average" choices. Vapor Deck users want to be WOWED. Every design should feel like it was custom-made for a high-budget tech launch or a premium design agency.

## JSON Configuration Schema

Your output `design_config` should be rich and descriptive:
- `color_palette`: 5-6 hex codes (Primary, Secondary, Accent, Muted, Background, Surface).
- `font_hints`: 2-3 specific fonts and fallback types.
- `tone`: A 1-3 word evocative name for the style.
- `atmospheric_feel`: A detailed description of the emotional impact.
- `color_theory_intent`: Explanation of why this palette was chosen and how to use it (e.g., "using #FF003C strictly for high-priority callouts and active states").
- `component_styles`: Description of the visual DNA for UI elements (buttons, cards, borders).
- `layout_preferences`: Rules for spacing, grids, and composition.
- `visual_elements`: Specific decorative motifs to include (e.g., "grainy gradients", "0.5pt hairlines").
