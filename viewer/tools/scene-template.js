// a scene file: UmaStudio loads this (Render tab, Scene file) and puts it on the timeline.
// times in seconds, positions in metres [x, y, z] in the place's world, turns (ry) in degrees:
// 0 faces +z, 90 faces +x. docs/scenes.md has every call.
export default {
  title: 'New scene',
  length: 12,
  size: '1080x1920',
  fps: 30,
  fov: 32,
  place: 'race:race10006',                 // Tokyo Racecourse; { id, cond: [season, weather, time], alt }
  extras: [],                              // other places mixed in: [{ key: 'gt1', id: 'race:race00000' }]
  cast: { spe: 1001, gs: 1007 },           // alias: chara id (or { chara, dress }); the first is the main uma
  props: {
    shovel: { model: 'shovel.glb', hand: 'gs', grip: { p: [0, -0.257, 0.705], rx: -70 } },
    dirt: 'divot2.glb',                    // a .glb standing in the world
  },

  build(s) {
    const SPOT = [0, 0, 193];

    s.beat(0, 4, 'She wants a racecourse', { say: 'So you want your own racecourse.' });
    s.at('spe', 0, SPOT, 180);
    s.motion('spe', 0, 'Idle_Loop').face('spe', 0, 'WaraiA');
    s.hide('gs', 0, 4);
    s.shot(0, 4, { on: 'spe', size: 'full', to: { size: 'upper' }, angle: 15 });

    s.beat(4, 8, 'Gold Ship starts digging', { say: 'Gold Ship has a shovel.' });
    s.at('gs', 4, s.front(SPOT, 180, 2.2, 1.0), 180 + 40);
    s.motion('gs', 4, 'Farm_Harvest').face('gs', 4, 'WaraiB');
    s.show('shovel', 4, 8);
    s.pop('dirt', 5.2, { s: 0.7 });
    s.key('dirt', 5.2, { p: s.on(1.2, 190.6) });      // on the ground there
    s.face('spe', 4, 'OdorokiA');
    s.shot(4, 8, { on: ['spe', 'gs'], size: 'full', angle: -25 });
    s.shake(5.2, 0.4, 0.08);

    s.beat(8, 12, 'She is not happy', { say: 'That is not how racecourses work.' });
    s.motion('spe', 8, 'Idle_No_Loop').face('spe', 8, 'IkariA');
    s.shot(8, 12, { on: 'spe', size: 'close', to: { size: 'face' }, angle: 10 });
  },
};
