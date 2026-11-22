import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

import { Role, JoinRoomResponse } from './models/chat.models';
import { UnlockComponent } from './pages/unlock/unlock.component';
import { RoleSelectComponent } from './pages/role-select/role-select.component';
import { ChatRoomComponent } from './pages/chat-room/chat-room.component';
import { CallModalComponent } from './components/call-modal/call-modal.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    UnlockComponent,
    RoleSelectComponent,
    ChatRoomComponent,
    CallModalComponent
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  // Navigation Stage: 'unlock' -> 'role' -> 'chat'
  currentStage: 'unlock' | 'role' | 'chat' = 'unlock';

  // Room & Authentication State
  activeRoomId = '';
  encryptionKey: CryptoKey | null = null;
  myRole: Role | '' = '';
  joinRoomData?: JoinRoomResponse;

  /**
   * Stage 1: Room unlocked with credentials & key derived
   */
  onUnlocked(event: { roomId: string; encryptionKey: CryptoKey }): void {
    this.activeRoomId = event.roomId;
    this.encryptionKey = event.encryptionKey;
    this.currentStage = 'role';
  }

  /**
   * Stage 2: Identity / Role selected (Harry or Elira)
   */
  onRoleJoined(event: { role: Role; response: JoinRoomResponse }): void {
    this.myRole = event.role;
    this.joinRoomData = event.response;
    this.currentStage = 'chat';
  }

  /**
   * Leave Chat room and return to unlock screen
   */
  onLeaveChat(): void {
    window.location.reload();
  }
}
