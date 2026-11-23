import { Component, EventEmitter, HostListener, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-lightbox',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './lightbox.component.html',
  styleUrls: ['./lightbox.component.css']
})
export class LightboxComponent {
  @Input() show = false;
  @Input() imageUrl = '';
  @Input() title = '';

  @Output() close = new EventEmitter<void>();

  zoomLevel = 1;
  panX = 0;
  panY = 0;

  isDragging = false;
  dragStartX = 0;
  dragStartY = 0;
  hasMoved = false;

  private initialPinchDist = 0;
  private initialPinchZoom = 1;

  readonly Math = Math;

  onClose(): void {
    this.resetTransform();
    this.close.emit();
  }

  zoomIn(): void {
    this.zoomLevel = Math.min(Number((this.zoomLevel + 0.4).toFixed(2)), 4);
  }

  zoomOut(): void {
    this.zoomLevel = Math.max(Number((this.zoomLevel - 0.4).toFixed(2)), 1);
    if (this.zoomLevel <= 1) {
      this.resetTransform();
    }
  }

  resetZoom(): void {
    this.resetTransform();
  }

  resetTransform(): void {
    this.zoomLevel = 1;
    this.panX = 0;
    this.panY = 0;
    this.isDragging = false;
    this.hasMoved = false;
    this.initialPinchDist = 0;
  }

  onImageClick(event: MouseEvent): void {
    event.stopPropagation();
    if (this.hasMoved) {
      this.hasMoved = false;
      return;
    }
    if (this.zoomLevel > 1) {
      this.resetTransform();
    } else {
      this.zoomLevel = 2;
    }
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaY < 0) {
      this.zoomIn();
    } else {
      this.zoomOut();
    }
  }

  // --- Mouse Drag Events (Desktop) ---
  onMouseDown(event: MouseEvent): void {
    if (this.zoomLevel <= 1) return;
    this.isDragging = true;
    this.hasMoved = false;
    this.dragStartX = event.clientX - this.panX;
    this.dragStartY = event.clientY - this.panY;
    event.preventDefault();
  }

  @HostListener('window:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (!this.isDragging) return;
    const newX = event.clientX - this.dragStartX;
    const newY = event.clientY - this.dragStartY;
    if (Math.abs(newX - this.panX) > 3 || Math.abs(newY - this.panY) > 3) {
      this.hasMoved = true;
    }
    this.panX = newX;
    this.panY = newY;
  }

  @HostListener('window:mouseup')
  onMouseUp(): void {
    this.isDragging = false;
  }

  // --- Touch Drag & Pinch Events (Mobile / Tablet) ---
  onTouchStart(event: TouchEvent): void {
    if (event.touches.length === 1) {
      // 1 Finger: Pan / Swipe
      this.isDragging = true;
      this.hasMoved = false;
      this.dragStartX = event.touches[0].clientX - this.panX;
      this.dragStartY = event.touches[0].clientY - this.panY;
    } else if (event.touches.length === 2) {
      // 2 Fingers: Pinch-to-zoom
      this.isDragging = false;
      const dx = event.touches[0].clientX - event.touches[1].clientX;
      const dy = event.touches[0].clientY - event.touches[1].clientY;
      this.initialPinchDist = Math.hypot(dx, dy);
      this.initialPinchZoom = this.zoomLevel;
    }
  }

  onTouchMove(event: TouchEvent): void {
    if (event.touches.length === 1 && this.isDragging && this.zoomLevel > 1) {
      event.preventDefault();
      const newX = event.touches[0].clientX - this.dragStartX;
      const newY = event.touches[0].clientY - this.dragStartY;
      if (Math.abs(newX - this.panX) > 3 || Math.abs(newY - this.panY) > 3) {
        this.hasMoved = true;
      }
      this.panX = newX;
      this.panY = newY;
    } else if (event.touches.length === 2 && this.initialPinchDist > 0) {
      event.preventDefault();
      const dx = event.touches[0].clientX - event.touches[1].clientX;
      const dy = event.touches[0].clientY - event.touches[1].clientY;
      const currentDist = Math.hypot(dx, dy);
      const ratio = currentDist / this.initialPinchDist;
      this.zoomLevel = Math.min(Math.max(Number((this.initialPinchZoom * ratio).toFixed(2)), 1), 4);
      if (this.zoomLevel <= 1) {
        this.panX = 0;
        this.panY = 0;
      }
    }
  }

  onTouchEnd(event: TouchEvent): void {
    this.isDragging = false;
    if (event.touches.length < 2) {
      this.initialPinchDist = 0;
    }
    if (this.zoomLevel <= 1) {
      this.resetTransform();
    }
  }
}
