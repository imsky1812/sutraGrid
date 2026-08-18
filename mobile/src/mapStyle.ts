/**
 * Dark map styling to match the reference: a near-black city with the green
 * cast of the app canvas, almost no labels, and no points of interest.
 *
 * Everything here is tuned so the lime route is the only saturated thing on
 * screen. A driver following a corridor does not need restaurant pins, and each
 * extra label competes with the one line that matters.
 */
export const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#0D0F0B' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6B6F65' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0D0F0B' }] },

  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#2A2F24' }] },
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.neighborhood', stylers: [{ visibility: 'off' }] },

  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#141711' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#111410' }] },

  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#161B12' }, { visibility: 'on' }] },

  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#20241B' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#171A13' }] },
  { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2A2F24' }] },
  { featureType: 'road.highway', elementType: 'labels', stylers: [{ visibility: 'simplified' }] },

  { featureType: 'transit', stylers: [{ visibility: 'off' }] },

  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0A0C08' }] },
  { featureType: 'water', elementType: 'labels.text', stylers: [{ visibility: 'off' }] },
];
