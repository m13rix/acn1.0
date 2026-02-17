import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import {Video} from '@remotion/media';
import React from 'react';

export const Shot10: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Slow close-up (Ken Burns)
	const scale = interpolate(frame, [0, durationInFrames], [1, 1.2], {
		extrapolateRight: 'clamp',
		easing: Easing.out(Easing.quad),
	});

	// Fade to black transition at the end (last 0.5s)
	const fadeOutStart = durationInFrames - 15;
	const fadeOpacity = interpolate(frame, [fadeOutStart, durationInFrames], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			{/* Main Image with Bokeh-like zoom */}
			<AbsoluteFill
				style={{
					transform: `scale(${scale})`,
				}}
			>
				<Img
					src={staticFile('passport_closing.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Warm Lighting Overlay */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle at 30% 30%, rgba(255, 200, 100, 0.4), transparent 70%)',
					mixBlendMode: 'soft-light',
					pointerEvents: 'none',
				}}
			/>
			<AbsoluteFill
				style={{
					backgroundColor: 'rgba(255, 150, 50, 0.1)',
					mixBlendMode: 'overlay',
					pointerEvents: 'none',
				}}
			/>

			{/* Film Grain Overlay */}
			<AbsoluteFill style={{opacity: 0.2, pointerEvents: 'none'}}>
				<Video
					src={staticFile('film_grain.mp4')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
					muted
					loop
				/>
			</AbsoluteFill>

			{/* Fade to Black */}
			<AbsoluteFill
				style={{
					backgroundColor: 'black',
					opacity: fadeOpacity,
					pointerEvents: 'none',
				}}
			/>

			<Audio src={staticFile('shot10_voice.mp3')} />
		</AbsoluteFill>
	);
};
