import mongoose, { Document, Schema } from "mongoose";

export interface IPlayer {
  username: string;
  paidStatus: string;
  jerseyColor: string;
  position: string;
}

const PlayerSchema: Schema = new Schema(
  {
    username: { type: String, required: true },
    paidStatus: { type: String, required: true },
    jerseyColor: { type: String, required: true },
    position: { type: String, required: true },
  },
  { _id: false } // optionally disable _id for subdocuments if not needed
);

export interface IEvent extends Document {
  name: string;
  location: string;
  time: string;
  date: string;
  totalSpots: number;
  rosterSpotsFilled: number;
  eventType: string;
  createdBy: string;
  roster: IPlayer[];
}

const EventSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    location: { type: String, required: true },
    time: { type: String, required: true },
    date: { type: String, required: true },
    totalSpots: { type: Number, required: true },
    rosterSpotsFilled: { type: Number, default: 0 },
    eventType: { type: String, required: true },
    createdBy: { type: String, required: true },
    roster: { type: [PlayerSchema], default: [] },
  },
  { timestamps: true }
);

const Event = mongoose.model<IEvent>("Event", EventSchema);

export default Event;
