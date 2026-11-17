type Transition = { finished: Promise<void>; skip: () => void };

export type GalleryWave = (target: HTMLElement, update: () => void, source: HTMLElement) => Transition;

export function createGalleryWaveRunner() {
  let active: { transition: Transition; commit: () => void } | undefined;
  return {
    run(wave: GalleryWave | undefined, target: HTMLElement, source: HTMLElement, update: () => void) {
      if (active) {
        const previous = active;
        active = undefined;
        previous.commit();
        previous.transition.skip();
        update();
        return;
      }
      if (!wave) {
        update();
        return;
      }

      let pending = true;
      const commit = () => {
        if (!pending) return;
        pending = false;
        update();
      };
      try {
        const transition = wave(target, commit, source);
        const running = {
          commit,
          transition: {
            finished: transition.finished,
            skip: () => {
              pending = false;
              transition.skip();
            },
          },
        };
        active = running;
        const finish = () => {
          if (active !== running) return;
          active = undefined;
          commit();
        };
        void transition.finished.then(finish, finish);
      } catch {
        commit();
      }
    },
    dispose() {
      const running = active;
      active = undefined;
      running?.transition.skip();
    },
  };
}
