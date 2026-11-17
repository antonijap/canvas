import type { Team } from "./team";
import type { Room } from "./room";
import type { AuthSettings } from "./auth";

export interface Env extends AuthSettings {
  TEAM: DurableObjectNamespace<Team>;
  ROOM: DurableObjectNamespace<Room>;
  OWNER_EMAILS: string;
  SERVER_VERSION: string;
}
