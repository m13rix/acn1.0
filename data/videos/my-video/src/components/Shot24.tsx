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

export const Shot24: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 10.3s total
	// Original split: 7s (Before), 7-14s (Falling) -> 50/50 split
	const splitFrame = Math.round(durationInFrames / 2);

	// Mask Falling Animation
	const fallProgress = interpolate(
		frame,
		[splitFrame, splitFrame + 20],
		[0, 1],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.quad)}
	);

	const maskY = interpolate(fallProgress, [0, 1], [0, 1200]);
	const maskRotate = interpolate(fallProgress, [0, 1], [0, 45]);

	// Pulse Red Effect for Text
	const pulse = Math.sin(frame * 0.2) * 0.2 + 1;
	const textOpacity = interpolate(frame, [splitFrame + 10, splitFrame + 25], [0, 1], {
		extrapolateLeft: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			{/* Revealed Face Underneath (Second state) */}
			<AbsoluteFill>
				<Img
					src={staticFile('woman_returning.png')} // Reusing an asset as "different face"
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'grayscale(0.3) brightness(0.7)',
					}}
				/>
			</AbsoluteFill>

			{/* Bride in Veil Mask (First state) */}
			<AbsoluteFill
				style={{
					transform: `translateY(${maskY}px) rotate(${maskRotate}deg)`,
				}}
			>
				<Img
					src={staticFile('mask_falling.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Pulsing Red Text */}
			<AbsoluteFill className="justify-center items-center">
				<div
					style={{
						opacity: textOpacity,
						transform: `scale(${pulse})`,
					}}
				>
					<h2
						className="text-red-600 text-9xl font-black uppercase tracking-widest"
						style={{
							fontFamily: 'Inter, sans-serif',
							filter: 'drop-shadow(0 0 20px rgba(255, 0, 0, 0.8))',
						}}
					>
						Обман
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot24_voice.mp3')} />
		</AbsoluteFill>
	);
};
