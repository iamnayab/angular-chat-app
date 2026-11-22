import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Role, JoinRoomResponse } from '../../models/chat.models';
import { SocketService } from '../../services/socket.service';

@Component({
  selector: 'app-role-select',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './role-select.component.html',
  styleUrls: ['./role-select.component.css']
})
export class RoleSelectComponent {
  @Input({ required: true }) roomId!: string;
  @Output() roleJoined = new EventEmitter<{ role: Role; response: JoinRoomResponse }>();

  isJoiningRole = false;
  roleJoiningTarget: Role | '' = '';
  identityError = '';

  constructor(private socketService: SocketService) {}

  async onChooseRole(role: Role): Promise<void> {
    if (this.isJoiningRole) return;

    this.isJoiningRole = true;
    this.roleJoiningTarget = role;
    this.identityError = '';

    try {
      const res = await this.socketService.joinRoom(this.roomId, role);

      this.isJoiningRole = false;
      this.roleJoiningTarget = '';

      if (!res?.ok) {
        this.identityError = res?.error || 'Could not enter room.';
        return;
      }

      this.roleJoined.emit({ role, response: res });
    } catch (err: any) {
      this.isJoiningRole = false;
      this.roleJoiningTarget = '';
      this.identityError = 'Server error joining room: ' + (err.message || err);
    }
  }
}
