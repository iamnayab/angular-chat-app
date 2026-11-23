import { Component, EventEmitter, Input, Output } from '@angular/core';
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
  readonly Math = Math;

  onClose(): void {
    this.zoomLevel = 1;
    this.close.emit();
  }

  zoomIn(): void {
    this.zoomLevel = Math.min(Number((this.zoomLevel + 0.3).toFixed(2)), 4);
  }

  zoomOut(): void {
    this.zoomLevel = Math.max(Number((this.zoomLevel - 0.3).toFixed(2)), 0.6);
  }

  resetZoom(): void {
    this.zoomLevel = 1;
  }

  toggleZoom(event: MouseEvent): void {
    event.stopPropagation();
    if (this.zoomLevel > 1) {
      this.zoomLevel = 1;
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
}
