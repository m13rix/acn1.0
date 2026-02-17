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
import React from 'react';

export const Shot15: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Slow zoom on sitting person (0-10s scaled to 6.84s)
	const scale = interpolate(frame, [0, durationInFrames], [1, 1.3], {
		easing: Easing.out(Easing.quad),
	});

	// Emphasis on empty chair (dramatic lighting)
	// We'll create a spotlight effect on the side where the chair would be (assuming right side)
	const spotLightOpacity = interpolate(frame, [0, durationInFrames / 2], [0, 0.6]);

	// Text Overlay 'один супруг'
	const textOpacity = interpolate(frame, [durationInFrames * 0.3, durationInFrames * 0.5], [0, 1]);

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			{/* Main Image */}
			<AbsoluteFill
				style={{
					transform: `scale(${scale})`,
					transformOrigin: 'center center', // Focus on center/person
				}}
			>
				<Img
					src={staticFile('single_at_zags.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'sepia(0.2) contrast(1.2)', // Documentary style
					}}
				/>
			</AbsoluteFill>

			{/* Spotlight on Empty Chair (Right side approximation) */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle at 75% 60%, rgba(255, 255, 200, 0.1) 0%, transparent 40%)',
					mixBlendMode: 'overlay',
					opacity: spotLightOpacity,
					pointerEvents: 'none',
				}}
			/>
			{/* Darken surroundings to emphasize spotlight */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle at 50% 50%, transparent 40%, rgba(0,0,0,0.6) 100%)',
					pointerEvents: 'none',
				}}
			/>

			{/* Text Overlay */}
			<AbsoluteFill className="justify-end items-center pb-32">
				<div style={{opacity: textOpacity, borderBottom: '4px solid white', paddingBottom: 10}}>
					<h2
						className="text-white text-6xl font-normal uppercase tracking-wider"
						style={{
							fontFamily: 'Inter, sans-serif',
						}}
					>
						один супруг
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot15_voice.mp3')} />
		</AbsoluteFill>
	);
};
