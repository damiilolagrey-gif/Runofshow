// Starter timelines. Times are "HH:MM" on the event date; roles name the vendors who own each cue.
const t = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

const templates = {
  'ng-wedding': {
    label: 'Nigerian wedding reception',
    vendors: [
      ['Lead coordinator', 'Planner team'], ['MC', 'MC'], ['DJ', 'DJ'], ['Live band', 'Live band'],
      ['Caterer', 'Caterer'], ['Small chops', 'Small chops'], ['Photographer', 'Photographer'],
      ['Videographer', 'Videographer'], ['Decorator', 'Decorator'], ['Cake vendor', 'Cake'],
      ['Usher team', 'Ushers'], ['Security', 'Security'], ['Makeup artist', 'Makeup'],
    ],
    cues: [
      ['09:00', 60, 'Venue access and decor setup', ['Decorator', 'Planner team']],
      ['12:00', 45, 'Sound check', ['DJ', 'Live band', 'MC']],
      ['12:30', 60, 'Bride makeup and getting-ready shots', ['Makeup', 'Photographer', 'Videographer']],
      ['13:00', 30, 'Kitchen setup and food arrival', ['Caterer', 'Small chops']],
      ['13:30', 15, 'Ushers and security briefing', ['Ushers', 'Security', 'Planner team']],
      ['14:00', 60, 'Guests arrive, small chops served', ['Ushers', 'Small chops', 'DJ']],
      ['15:30', 15, 'MC opens the reception', ['MC', 'DJ']],
      ['15:45', 15, 'Grand entrance of the couple', ['MC', 'DJ', 'Live band', 'Photographer', 'Videographer']],
      ['16:00', 15, 'Opening prayer and welcome', ['MC']],
      ['16:15', 15, "Chairman's remarks", ['MC', 'Photographer']],
      ['16:30', 45, 'Food service', ['Caterer', 'Ushers']],
      ['17:15', 10, 'First dance', ['DJ', 'MC', 'Photographer', 'Videographer']],
      ['17:30', 15, 'Cake cutting and toast', ['Cake', 'MC', 'Photographer', 'Videographer']],
      ['17:45', 60, 'Spraying and dance floor opens', ['Live band', 'DJ', 'MC', 'Security']],
      ['18:45', 15, 'Vote of thanks and send-off', ['MC', 'Photographer', 'Videographer']],
      ['19:00', 90, 'Teardown and clear-out', ['Decorator', 'Caterer', 'Planner team']],
    ],
  },
  corporate: {
    label: 'Corporate event / gala',
    vendors: [
      ['Event lead', 'Planner team'], ['Host', 'MC'], ['AV team', 'AV'], ['Caterer', 'Caterer'],
      ['Photographer', 'Photographer'], ['Decorator', 'Decorator'], ['Registration desk', 'Registration'],
    ],
    cues: [
      ['14:00', 120, 'Stage and decor setup', ['Decorator', 'AV']],
      ['16:00', 30, 'AV and mic check', ['AV', 'MC']],
      ['17:00', 60, 'Registration and welcome drinks', ['Registration', 'Caterer']],
      ['18:00', 10, 'Host welcome', ['MC', 'AV', 'Photographer']],
      ['18:10', 20, 'CEO keynote', ['AV', 'Photographer']],
      ['18:30', 60, 'Dinner service', ['Caterer']],
      ['19:30', 30, 'Awards', ['MC', 'AV', 'Photographer']],
      ['20:00', 60, 'Networking and close', ['Caterer', 'AV']],
      ['21:00', 60, 'Teardown', ['Decorator', 'AV', 'Planner team']],
    ],
  },
  conference: {
    label: 'Conference (one day)',
    vendors: [
      ['Conference lead', 'Planner team'], ['Compere', 'MC'], ['AV team', 'AV'], ['Caterer', 'Caterer'],
      ['Registration desk', 'Registration'], ['Photographer', 'Photographer'], ['Livestream crew', 'Stream'],
    ],
    cues: [
      ['07:00', 60, 'Doors, AV and stream setup', ['AV', 'Stream', 'Planner team']],
      ['08:00', 60, 'Registration and breakfast', ['Registration', 'Caterer']],
      ['09:00', 15, 'Opening remarks', ['MC', 'AV', 'Stream', 'Photographer']],
      ['09:15', 45, 'Keynote', ['AV', 'Stream', 'Photographer']],
      ['10:00', 60, 'Panel session', ['MC', 'AV', 'Stream']],
      ['11:00', 30, 'Coffee break', ['Caterer']],
      ['11:30', 90, 'Breakout sessions', ['AV', 'Planner team']],
      ['13:00', 60, 'Lunch', ['Caterer', 'Registration']],
      ['14:00', 120, 'Afternoon talks', ['MC', 'AV', 'Stream']],
      ['16:00', 30, 'Closing and group photo', ['MC', 'Photographer', 'Stream']],
    ],
  },
  blank: { label: 'Blank timeline', vendors: [], cues: [] },
};

// Starter checklists for the couple's progress view: [category, item, role of the vendor whose accepted agreement locks it].
templates['ng-wedding'].checklist = [
  ['Venue & ceremony', 'Reception venue booked'], ['Venue & ceremony', 'Church or registry booked'],
  ['Venue & ceremony', 'Traditional engagement date set'], ['Venue & ceremony', 'Ushers and security confirmed', 'Ushers'],
  ['Food & drink', 'Caterer booked', 'Caterer'], ['Food & drink', 'Small chops booked', 'Small chops'],
  ['Food & drink', 'Menu tasting done'], ['Food & drink', 'Drinks and bar sorted'], ['Food & drink', 'Cake ordered', 'Cake'],
  ['Flowers & styling', 'Decorator booked', 'Decorator'], ['Flowers & styling', 'Colours and theme agreed'],
  ['Flowers & styling', 'Makeup artist booked', 'Makeup'], ['Flowers & styling', 'Aso-ebi fabric chosen'],
  ['Photo, video & music', 'Photographer booked', 'Photographer'], ['Photo, video & music', 'Videographer booked', 'Videographer'],
  ['Photo, video & music', 'DJ booked', 'DJ'], ['Photo, video & music', 'Live band booked', 'Live band'], ['Photo, video & music', 'MC booked', 'MC'],
  ['Transport & extras', 'Wedding car booked'], ['Transport & extras', 'Guest list final'], ['Transport & extras', 'Invitations sent'],
  ['Transport & extras', 'Souvenirs ordered'],
];
templates.corporate.checklist = [
  ['Venue', 'Venue booked'], ['Venue', 'Decor agreed', 'Decorator'], ['Venue', 'AV booked', 'AV'],
  ['Programme', 'Host confirmed', 'MC'], ['Programme', 'Speakers confirmed'], ['Programme', 'Run of show signed off'],
  ['Guests', 'Invitations sent'], ['Guests', 'Registration set up', 'Registration'],
  ['Food & media', 'Caterer booked', 'Caterer'], ['Food & media', 'Photographer booked', 'Photographer'],
];
templates.conference.checklist = [
  ['Venue', 'Venue booked'], ['Venue', 'AV booked', 'AV'], ['Venue', 'Livestream booked', 'Stream'],
  ['Programme', 'Compere confirmed', 'MC'], ['Programme', 'Speakers confirmed'], ['Programme', 'Agenda published'],
  ['Attendees', 'Registration open', 'Registration'], ['Attendees', 'Badges printed'],
  ['Food & media', 'Caterer booked', 'Caterer'], ['Food & media', 'Photographer booked', 'Photographer'],
];
templates.blank.checklist = [];

for (const tpl of Object.values(templates)) {
  tpl.cues = tpl.cues.map(([time, duration, title, roles]) => ({ start_min: t(time), duration, title, roles }));
  tpl.vendors = tpl.vendors.map(([name, role]) => ({ name, role }));
  tpl.checklist = tpl.checklist.map(([category, title, role = null]) => ({ category, title, role }));
}

module.exports = templates;
