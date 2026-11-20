import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { featureSwitchHref, type FeatureSwitchFlag } from "./feature-switches";

/** The link that goes with a "turned off" sentence: it opens that feature's switch on Settings › Advanced. */
export function FeatureOffLink({ flag }: { flag: FeatureSwitchFlag }) {
  return (
    <NativeOwnerLink scope={["feature-switch", flag]} href={featureSwitchHref(flag)} className="underline">
      Turn it on in Settings › Advanced
    </NativeOwnerLink>
  );
}
