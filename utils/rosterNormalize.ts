// Keep roster participant fields in sync when an event's type / jersey
// colors / payment-tracking setting changes. Without this, editing Hockey
// → Other leaves stale "Forward" / "Black" / "Paid" on every player.

const TEAM_SPORTS = new Set(
  [
    "Basketball",
    "Hockey",
    "Soccer",
    "Football",
    "Rugby",
    "Baseball",
    "Softball",
    "Lacrosse",
    "Volleyball",
  ].map((s) => s.toLowerCase()),
);

const POSITION_OPTIONS: Record<string, string[]> = {
  Basketball: ["Guard", "Forward", "Center"],
  Hockey: ["Forward", "Defense", "Goalie"],
  Soccer: ["Forward", "Midfielder", "Defender", "Goalkeeper"],
  "Figure Skating": ["Singles", "Pairs", "Ice Dance"],
  Tennis: ["Singles", "Doubles"],
  Golf: ["Player"],
  Football: [
    "Quarterback",
    "Running Back",
    "Wide Receiver",
    "Lineman",
    "Defense",
  ],
  Rugby: ["Forward", "Back"],
  Baseball: ["Pitcher", "Catcher", "Infield", "Outfield"],
  Softball: ["Pitcher", "Catcher", "Infield", "Outfield"],
  Lacrosse: ["Attack", "Midfield", "Defense", "Goalie"],
  Volleyball: ["Setter", "Outside Hitter", "Middle Blocker", "Libero"],
  "Trivia Night": ["Player", "Team Captain", "Host"],
  "Game Night": ["Player", "Host"],
  Karaoke: ["Singer", "Audience"],
  "Open Mic": ["Performer", "Audience"],
  "Watch Party": ["Attendee", "Host"],
  "Live Music": ["Attendee"],
  Hiking: ["Hiker", "Guide"],
  Cycling: ["Cyclist", "Guide"],
  Running: ["Runner", "Pacer"],
  Yoga: ["Participant", "Instructor"],
  Fishing: ["Angler"],
  Camping: ["Camper", "Organizer"],
  "Book Club": ["Reader", "Discussion Leader"],
  Workshop: ["Participant", "Instructor"],
  Meetup: ["Attendee", "Organizer"],
  Potluck: ["Guest", "Host"],
  Volunteer: ["Volunteer", "Coordinator"],
  Other: ["Participant"],
  Default: ["Participant"],
};

export const isTeamSportType = (eventType?: string | null): boolean =>
  !!eventType && TEAM_SPORTS.has(String(eventType).toLowerCase());

export const positionsForEventType = (eventType?: string | null): string[] =>
  POSITION_OPTIONS[String(eventType || "")] || POSITION_OPTIONS.Default;

export const defaultPositionFor = (eventType?: string | null): string =>
  positionsForEventType(eventType)[0] || "Participant";

/** Build roster entry fields for RSVP "going" / open join. */
export const resolveJoinParticipantFields = (
  event: any,
  overrides: {
    position?: string;
    jerseyColor?: string;
    paidStatus?: string;
  } = {},
): { position: string; jerseyColor: string; paidStatus: string } => {
  const eventType = String(event?.eventType || "Other");
  const teamSport = isTeamSportType(eventType);
  const validPositions = positionsForEventType(eventType);
  const allowedJerseys: string[] = teamSport
    ? Array.isArray(event?.jerseyColors)
      ? event.jerseyColors.filter(Boolean)
      : []
    : [];
  const trackPayment = teamSport && event?.trackPayment === true;

  let position = overrides.position || defaultPositionFor(eventType);
  if (!validPositions.includes(position)) {
    position = defaultPositionFor(eventType);
  }

  let jerseyColor = overrides.jerseyColor;
  if (!teamSport) {
    jerseyColor = "N/A";
  } else if (!jerseyColor || !allowedJerseys.includes(jerseyColor)) {
    jerseyColor = allowedJerseys[0] || "N/A";
  }

  let paidStatus = overrides.paidStatus;
  if (!trackPayment) {
    paidStatus = "N/A";
  } else if (paidStatus !== "Paid" && paidStatus !== "Unpaid") {
    paidStatus = "Unpaid";
  }

  return { position, jerseyColor: jerseyColor!, paidStatus: paidStatus! };
};

const positionsFor = (eventType: string): string[] =>
  positionsForEventType(eventType);

/** Mutates `event.roster` (and jersey/payment fields when leaving team sports). */
export const normalizeRosterForEventShape = (event: any): void => {
  if (!event) return;

  const eventType = String(event.eventType || "Other");
  const teamSport = isTeamSportType(eventType);
  const validPositions = positionsFor(eventType);
  const defaultPosition = validPositions[0] || "Participant";
  const allowedJerseys: string[] = teamSport
    ? Array.isArray(event.jerseyColors)
      ? event.jerseyColors.filter(Boolean)
      : []
    : [];

  if (!teamSport) {
    event.jerseyColors = [];
    event.trackPayment = false;
  }

  const trackPayment = teamSport && event.trackPayment === true;
  const roster = Array.isArray(event.roster) ? event.roster : [];

  event.roster = roster.map((raw: any) => {
    const p = raw?.toObject ? raw.toObject() : { ...raw };

    if (!validPositions.includes(p.position)) {
      p.position = defaultPosition;
    }

    if (!teamSport) {
      p.jerseyColor = "N/A";
      p.paidStatus = "N/A";
    } else {
      if (!allowedJerseys.includes(p.jerseyColor)) {
        p.jerseyColor = allowedJerseys[0] || "N/A";
      }
      if (!trackPayment) {
        p.paidStatus = "N/A";
      } else if (p.paidStatus !== "Paid" && p.paidStatus !== "Unpaid") {
        p.paidStatus = "Unpaid";
      }
    }

    return p;
  });

  if (typeof event.rosterSpotsFilled === "number") {
    event.rosterSpotsFilled = event.roster.length;
  }
};
