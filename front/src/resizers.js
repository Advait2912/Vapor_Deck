/**
 * Layout Resizing Logic
 */
import { elements } from './ui.js';

export function initResizers() {
  const hResizer = document.getElementById('resizer');
  const vResizer = document.getElementById('v-resizer');
  const rResizer = document.getElementById('r-resizer');
  let isDraggingH = false;
  let isDraggingV = false;
  let isDraggingR = false;

  if (!hResizer || !vResizer || !rResizer) {
    console.error('Resizer elements not found!');
    return;
  }

  // Horizontal Resizer (Left Sidebar)
  hResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDraggingH = true;
    hResizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    elements.slideIframe.style.pointerEvents = 'none';
  });

  // Horizontal Resizer (Right Sidebar)
  rResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDraggingR = true;
    rResizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    elements.slideIframe.style.pointerEvents = 'none';
  });

  // Vertical Resizer (Interaction Bar)
  vResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDraggingV = true;
    vResizer.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    elements.slideIframe.style.pointerEvents = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (isDraggingH) {
      const newWidth = e.clientX;
      if (newWidth > 150 && newWidth < 600) {
        document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
      }
    }

    if (isDraggingR) {
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth > 150 && newWidth < 600) {
        document.documentElement.style.setProperty('--right-sidebar-width', `${newWidth}px`);
      }
    }
    
    if (isDraggingV) {
      const windowHeight = window.innerHeight;
      const newHeight = windowHeight - e.clientY - 40; // 40px footer
      if (newHeight > 50 && newHeight < 500) {
        document.documentElement.style.setProperty('--interaction-height', `${newHeight}px`);
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDraggingH || isDraggingV || isDraggingR) {
      isDraggingH = false;
      isDraggingV = false;
      isDraggingR = false;
      hResizer.classList.remove('dragging');
      vResizer.classList.remove('dragging');
      rResizer.classList.remove('dragging');
      document.body.style.cursor = 'default';
      elements.slideIframe.style.pointerEvents = 'auto';
    }
  });
}
