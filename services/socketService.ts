import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

class SocketService {
  private io: Server | null = null;
  private userSockets: Map<string, Set<string>> = new Map();

  initialize(httpServer: HttpServer): Server {
    this.io = new Server(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
      pingInterval: 25000,
      pingTimeout: 20000,
    });

    this.io.use((socket: AuthenticatedSocket, next) => {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error("Authentication required"));
      }
      try {
        const secret = process.env.JWT_SECRET || "";
        const decoded = jwt.verify(token, secret) as any;
        socket.userId = decoded.id;
        // Also stash on `socket.data` — that's the field preserved on the
        // RemoteSocket handles returned by `fetchSockets()`, which we use
        // to compute group-room presence for push suppression.
        socket.data.userId = decoded.id;
        next();
      } catch {
        next(new Error("Invalid token"));
      }
    });

    this.io.on("connection", (socket: AuthenticatedSocket) => {
      const userId = socket.userId;
      if (!userId) {
        socket.disconnect();
        return;
      }

      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(socket.id);

      socket.join(`user:${userId}`);

      console.log(
        `🔌 Socket connected: user=${userId} socket=${socket.id} (${this.userSockets.get(userId)!.size} connections)`,
      );

      socket.on("join:event", (eventId: string) => {
        socket.join(`event:${eventId}`);
      });

      socket.on("leave:event", (eventId: string) => {
        socket.leave(`event:${eventId}`);
      });

      socket.on("join:group", (groupId: string) => {
        socket.join(`group:${groupId}`);
      });

      socket.on("leave:group", (groupId: string) => {
        socket.leave(`group:${groupId}`);
      });

      socket.on("disconnect", () => {
        const sockets = this.userSockets.get(userId);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            this.userSockets.delete(userId);
          }
        }
        console.log(`🔌 Socket disconnected: user=${userId} socket=${socket.id}`);
      });
    });

    console.log("🔌 Socket.io initialized");
    return this.io;
  }

  getIO(): Server | null {
    return this.io;
  }

  emitToUser(userId: string, event: string, data: any): void {
    this.io?.to(`user:${userId}`).emit(event, data);
  }

  emitToUsers(userIds: string[], event: string, data: any): void {
    for (const userId of userIds) {
      this.emitToUser(userId, event, data);
    }
  }

  emitToEvent(eventId: string, event: string, data: any): void {
    this.io?.to(`event:${eventId}`).emit(event, data);
  }

  emitToGroup(groupId: string, event: string, data: any): void {
    this.io?.to(`group:${groupId}`).emit(event, data);
  }

  emitToAll(event: string, data: any): void {
    this.io?.emit(event, data);
  }

  // Returns the set of userIds currently connected to a group's chat
  // room. Used to decide who needs a push notification for a new message
  // (people actively watching the thread get the live socket update
  // instead, so pushing them too would be noisy/redundant).
  async getUserIdsInGroupRoom(groupId: string): Promise<Set<string>> {
    const result = new Set<string>();
    if (!this.io) return result;
    try {
      const sockets = await this.io.in(`group:${groupId}`).fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as any)?.userId;
        if (uid) result.add(String(uid));
      }
    } catch {
      // fetchSockets can reject during shutdown/reconnect churn; treating
      // "unknown presence" as "nobody in room" just means we push a bit
      // more, which is the safe direction.
    }
    return result;
  }

  isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId) && this.userSockets.get(userId)!.size > 0;
  }
}

const socketService = new SocketService();
export default socketService;
