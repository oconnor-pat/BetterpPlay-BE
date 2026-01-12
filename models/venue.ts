import mongoose, { Document, Schema } from "mongoose";

export interface ISubVenue {
  id: string;
  name: string;
  type: string;
  capacity?: number;
}

export interface IAddress {
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

export interface ICoordinates {
  latitude: number;
  longitude: number;
}

export interface IOperatingHours {
  monday: { open: string; close: string } | null;
  tuesday: { open: string; close: string } | null;
  wednesday: { open: string; close: string } | null;
  thursday: { open: string; close: string } | null;
  friday: { open: string; close: string } | null;
  saturday: { open: string; close: string } | null;
  sunday: { open: string; close: string } | null;
}

export interface IVenue extends Document {
  name: string;
  type: string;
  address: IAddress;
  coordinates: ICoordinates;
  subVenues: ISubVenue[];
  amenities: string[];
  contactEmail?: string;
  contactPhone?: string;
  website?: string;
  imageUrl?: string;
  operatingHours?: IOperatingHours;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SubVenueSchema: Schema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    capacity: { type: Number, required: false },
  },
  { _id: false }
);

const AddressSchema: Schema = new Schema(
  {
    street: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zipCode: { type: String, required: true },
    country: { type: String, required: true },
  },
  { _id: false }
);

const CoordinatesSchema: Schema = new Schema(
  {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
  },
  { _id: false }
);

const TimeSlotSchema: Schema = new Schema(
  {
    open: { type: String, required: true },
    close: { type: String, required: true },
  },
  { _id: false }
);

const OperatingHoursSchema: Schema = new Schema(
  {
    monday: { type: TimeSlotSchema, default: null },
    tuesday: { type: TimeSlotSchema, default: null },
    wednesday: { type: TimeSlotSchema, default: null },
    thursday: { type: TimeSlotSchema, default: null },
    friday: { type: TimeSlotSchema, default: null },
    saturday: { type: TimeSlotSchema, default: null },
    sunday: { type: TimeSlotSchema, default: null },
  },
  { _id: false }
);

const VenueSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, required: true },
    address: { type: AddressSchema, required: true },
    coordinates: { type: CoordinatesSchema, required: true },
    subVenues: { type: [SubVenueSchema], default: [] },
    amenities: { type: [String], default: [] },
    contactEmail: { type: String, required: false },
    contactPhone: { type: String, required: false },
    website: { type: String, required: false },
    imageUrl: { type: String, required: false },
    operatingHours: { type: OperatingHoursSchema, required: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Create indexes for efficient querying
VenueSchema.index({ "address.city": 1, "address.state": 1 });
VenueSchema.index({ type: 1 });
VenueSchema.index({ isActive: 1 });
VenueSchema.index({ "coordinates.latitude": 1, "coordinates.longitude": 1 });

const Venue = mongoose.model<IVenue>("Venue", VenueSchema);

export default Venue;
