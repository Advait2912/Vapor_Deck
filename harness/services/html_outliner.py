"""
Phase 3: DOM Outliner

Converts a slide's full HTML into a compact structural skeleton.
Reduces ~3000 tokens of HTML to ~100 tokens of structure for the refine LLM.

Example output:
  section.slide
    style (scoped, ~2400 chars)
    div.hero-container
      h1.main-title "The Future of AI"
      p.subtitle "3 key trends reshaping..."
      div.stats-row
        div.stat-card (x3)
    script (interactive)
"""
import logging
from bs4 import BeautifulSoup, Tag

logger = logging.getLogger("html_outliner")

# Tags to summarise rather than recurse into
_LEAF_TAGS = {"style", "script", "svg", "canvas"}
# Max preview length for text content in leaf nodes
_TEXT_PREVIEW = 60
# Max siblings before collapsing into "(xN)"
_COLLAPSE_THRESHOLD = 3


def extract_dom_outline(html: str, max_depth: int = 5) -> str:
    """
    Strips a slide's HTML to a structural skeleton.
    Replaces full HTML in refine/audit prompts — massive token reduction.
    """
    try:
        soup = BeautifulSoup(html, "html.parser")
        section = soup.find("section")
        if not section:
            # Fallback: try body or root
            section = soup.find("body") or soup
            logger.debug("[html_outliner] no <section> found, using root element")

        lines: list[str] = []
        _walk(section, lines, depth=0, max_depth=max_depth)
        result = "\n".join(lines)
        logger.debug(
            f"[html_outliner] outline: {len(html)} chars HTML → "
            f"{len(result)} chars outline ({len(lines)} nodes)"
        )
        return result
    except Exception as e:
        logger.warning(f"[html_outliner] parse failed: {e}")
        return "(DOM outline unavailable)"


def _walk(el, lines: list[str], depth: int, max_depth: int) -> None:
    if depth > max_depth:
        return
    if not isinstance(el, Tag):
        return

    name = el.name
    if not name:
        return

    indent = "  " * depth

    # ── Leaf tags: summarise, don't recurse ──────────────────────────────────
    if name in _LEAF_TAGS:
        content_len = len(el.get_text())
        lines.append(f"{indent}{name} (scoped, ~{content_len} chars)")
        return

    # ── Build tag descriptor ──────────────────────────────────────────────────
    classes = ".".join(el.get("class", []))
    el_id = el.get("id", "")
    tag_str = name
    if el_id:
        tag_str += f"#{el_id}"
    if classes:
        tag_str += f".{classes.replace(' ', '.')}"

    children = [c for c in el.children if isinstance(c, Tag)]

    # ── Leaf node with text ───────────────────────────────────────────────────
    if not children:
        text = el.get_text(strip=True)
        if text:
            preview = text[:_TEXT_PREVIEW].replace("\n", " ")
            lines.append(f'{indent}{tag_str} "{preview}"')
        else:
            lines.append(f"{indent}{tag_str}")
        return

    # ── Collapse repeated same-tag siblings ──────────────────────────────────
    if len(children) >= _COLLAPSE_THRESHOLD:
        tag_names = [c.name for c in children]
        if len(set(tag_names)) == 1:
            lines.append(f"{indent}{tag_str} > {tag_names[0]} (x{len(children)})")
            return

    # ── Normal recursive node ─────────────────────────────────────────────────
    lines.append(f"{indent}{tag_str}")
    for child in children:
        _walk(child, lines, depth + 1, max_depth)
