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

export const Shot20: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 6.6s total
	// Split at 50% (3.3s)
	const splitFrame = Math.round(durationInFrames / 2);

	// Fog Animation
	const fogOpacity = interpolate(frame, [0, splitFrame], [0.3, 0.5], {
		extrapolateRight: 'clamp',
	});

	// Split Transition (revealing from center)
	const transitionProgress = interpolate(
		frame,
		[splitFrame - 15, splitFrame + 15],
		[0, 100],
		{
			extrapolateLeft: 'clamp',
			extrapolateRight: 'clamp',
			easing: Easing.inOut(Easing.quad),
		}
	);

	return (
		<AbsoluteFill style={{backgroundColor: '#0a0a0a'}}>
			{/* Shot 1: Foggy Cemetery */}
			<AbsoluteFill>
				<Img
					src={staticFile('cemetery_foggy.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'grayscale(0.5) brightness(0.7) contrast(1.1)',
					}}
				/>
				{/* Fog Overlay */}
				<AbsoluteFill
					style={{
						background: 'radial-gradient(circle, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 70%)',
						opacity: fogOpacity,
						filter: 'blur(20px)',
					}}
				/>
			</AbsoluteFill>

			{/* Shot 2: Gavel and Gravestone with Split Transition */}
			<AbsoluteFill
				style={{
					clipPath: `inset(0 ${50 - transitionProgress / 2}% 0 ${50 - transitionProgress / 2}%)`,
				}}
			>
				<Img
					src={staticFile('gavel_gravestone.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'grayscale(0.3) brightness(0.8) contrast(1.2)',
					}}
				/>
				{/* Somber Cool Tone */}
				<AbsoluteFill
					style={{
						backgroundColor: 'rgba(0, 20, 50, 0.2)',
						mixBlendMode: 'multiply',
					}}
				/>
			</AbsoluteFill>

			{/* Overall Vignette for Somber Tone */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle, transparent 40%, rgba(0,0,0,0.7) 100%)',
					pointerEvents: 'none',
				}}
			/>

			<Audio src={staticFile('shot20_voice.mp3')} />
		</AbsoluteFill>
	);
};
