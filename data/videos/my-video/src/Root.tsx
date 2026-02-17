import React from 'react';
import {Composition} from 'remotion';
import {Main} from './Main';

export const RemotionRoot: React.FC = () => {
	return (
		<>
			<Composition
				id="Main"
				component={Main}
				durationInFrames={Math.round((281.79 + 4.22) * 30)}
				fps={30}
				width={1920}
				height={1080}
			/>
		</>
	);
};
