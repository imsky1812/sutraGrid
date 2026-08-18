/**
 * Dark map styling, ported verbatim from admin-dashboard/app.js so the phone
 * and the operator dashboard render the same city.
 */
export const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#0b0f19' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0b0f19' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#7b8a9b' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#1f293d' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#0d1324' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#0d1324' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#4b5b75' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#161d30' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#0d1324' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8a9ab0' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#1f2d47' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#0f1826' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#0e1526' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#05070d' }] },
];
