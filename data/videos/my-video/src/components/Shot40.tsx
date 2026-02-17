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

export const Shot40: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 4.22s total
	// Original split: 4s (Close-up), 4-6s (Pull back) -> ~2/3 and 1/3 split
	const splitFrame = Math.round((4 / 6) * durationInFrames);

	// Camera Pull Back Animation
	// Starts with heavy zoom, then pulls out to full view
	const pullBackProgress = interpolate(
		frame,
		[splitFrame, durationInFrames],
		[0, 1],
		{extrapolateLeft: 'clamp', easing: Easing.out(Easing.poly(2))}
	);

	const scale = interpolate(pullBackProgress, [0, 1], [2.5, 1]);
	const blur = interpolate(pullBackProgress, [0.8, 1], [0, 2]); // Cinematic soft ending

	// Title Card Appearance
	const titleOpacity = interpolate(
		frame,
		[durationInFrames - 45, durationInFrames - 15],
		[0, 1],
		{extrapolateLeft: 'clamp'}
	);

	return (
		<AbsoluteFill style={{backgroundColor: 'white'}}>
			{/* Main Image with Pull Back */}
			<AbsoluteFill
				style={{
					transform: `scale(${scale})`,
					filter: `blur(${blur}px)`,
				}}
			>
				<Img
					src={staticFile('passport_book_life.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Bokeh / Warm Light Overlay */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle at 80% 20%, rgba(255, 200, 150, 0.3) 0%, transparent 60%)',
					mixBlendMode: 'screen',
					opacity: interpolate(frame, [0, durationInFrames], [0.2, 0.5]),
				}}
			/>
			
			{/* Final Title Card */}
			<AbsoluteFill
				className="justify-center items-center"
				style={{
					backgroundColor: `rgba(0, 0, 0, ${interpolate(titleOpacity, [0, 1], [0, 0.8])})`,
					opacity: titleOpacity,
				}}
			>
				<h1
					className="text-white text-8xl font-black uppercase tracking-widest text-center"
					style={{
						fontFamily: 'Inter, sans-serif',
						textShadow: '0 0 40px rgba(255,255,255,0.5)',
					}}
				>
					Юридическая грамотность
				</h1>
			</AbsoluteFill>

			<Audio src={staticFile('shot40_voice.mp3')} />
		</AbsoluteFill>
	);
};
