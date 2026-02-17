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

export const Shot37: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 6.77s total
	// Segments: 0-6s (Sunset), 6-12s (Merge) -> ~50/50 split
	const splitFrame = Math.round(durationInFrames / 2);

	// Cross-fade / Morph Simulation
	const transitionProgress = interpolate(
		frame,
		[splitFrame - 15, splitFrame + 15],
		[0, 1],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.quad)}
	);

	// Warm Sunset Glow Effect
	const sunsetGlow = interpolate(frame, [0, splitFrame], [0.4, 0.6], {extrapolateRight: 'clamp'});
	
	// Text Overlay
	const textOpacity = interpolate(frame, [splitFrame, splitFrame + 20], [0, 1], {extrapolateLeft: 'clamp'});

	return (
		<AbsoluteFill style={{backgroundColor: '#1a0a00'}}>
			{/* Segment 1: Family Sunset */}
			<AbsoluteFill style={{opacity: 1 - transitionProgress}}>
				<Img
					src={staticFile('family_sunset.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
				{/* Sunset Warmth Overlay */}
				<AbsoluteFill
					style={{
						background: 'linear-gradient(to top, rgba(255, 100, 0, 0.4), transparent)',
						opacity: sunsetGlow,
						mixBlendMode: 'overlay',
					}}
				/>
			</AbsoluteFill>

			{/* Segment 2: State-Family Merge */}
			<AbsoluteFill style={{opacity: transitionProgress}}>
				<Img
					src={staticFile('state_family_merge.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
				{/* Convergence Glow */}
				<AbsoluteFill
					style={{
						background: 'radial-gradient(circle, rgba(255, 255, 255, 0.2) 0%, transparent 70%)',
						mixBlendMode: 'screen',
					}}
				/>
			</AbsoluteFill>

			{/* Overlay Text */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="bg-black/60 px-10 py-5 rounded-2xl backdrop-blur-md border border-white/20 text-center"
					style={{
						opacity: textOpacity,
						transform: `scale(${interpolate(textOpacity, [0, 1], [0.9, 1])})`
					}}
				>
					<h2 
						className="text-white text-4xl font-bold uppercase tracking-widest"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						Государство + Семья = Правовая конструкция
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot37_voice.mp3')} />
		</AbsoluteFill>
	);
};
